/**
 * The session's `try_lines`: test statements tried against the live app
 * before they go into a test. The code is parsed into the closed grammar of
 * `lines-parse.ts` and never evaluated; the runner walks the parsed chains
 * and reaches each fixture member by a name the grammar's table listed, on
 * the session's own fixtures, so a tried line waits, matches, and fails as
 * the same line in a test would. Statements run in order and stop at the
 * first failure, each with its wait capped at the call's `timeout`, and the
 * result ends with what changed on screen.
 *
 * The coding agent is not trusted the way test code is. A Secret reaches the
 * screen only through the authorization `type_secret` runs, on the node the
 * fill lands on. Reads come back through the attempt's secret ledger, and the
 * session's result redaction covers the rest. While a secret value shows on
 * screen, a statement that matches part of a text is refused, since its pass
 * or fail would tell the value apart a piece at a time.
 */

import type { ToolExecutionOptions, ToolSet } from 'ai';
import { z } from 'zod';
import type { StepExecutorContext } from '../agent/executor.ts';
import type { AgentContext } from '../agent/invocation.ts';
import { recordPolicyEvent } from '../agent/phases.ts';
import type { ScreenPresenter } from '../agent/screen-update.ts';
import { authorizeSecretFill } from '../agent/secrets.ts';
import { expect } from '../expect/index.ts';
import { classifyError, codedMessage, ConfigurationError, TestError, type E2EError } from '../internal/errors.ts';
import { rejectUnknownOptions } from '../internal/options.ts';
import { describeExpression } from '../locator/expression.ts';
import { locatorInternals } from '../locator/screen.ts';
import type { AttemptBudget } from '../run/budget.ts';
import { secretHandle } from '../secrets.ts';
import type { ActionOptions, Secret, TestFixtures } from '../types.ts';
import { parseLines, type Call, type Chain, type Statement, type Value } from './lines-parse.ts';

/** How long one statement may wait unless the call says otherwise, in milliseconds. */
const TRY_LINES_TIMEOUT_MS = 5_000;
/** The longest a call may let one statement wait. */
const MAX_TIMEOUT_MS = 120_000;
/** What the secret ledger leaves where a value was. */
const SECRET_MARKER = '<secret:';

export interface TryLinesOptions {
  /** The session attempt's fixtures, the ones a test body gets. */
  readonly fixtures: TestFixtures;
  /** The fixtures the target's engine contributes, which `try_lines` names in a refusal and never runs. */
  readonly engineFixtures: readonly string[];
  /** The attempt's agent runtime: its config, secret resolver, ledger, and pixel exposure. */
  readonly runtime: AgentContext;
  /** The attempt's budget, capped per statement. */
  readonly budget: AttemptBudget;
  /** The session step, observed once the statements ran. */
  readonly context: StepExecutorContext;
  /** The session's presenter, so the screen comes back as changes since the one the agent holds. */
  readonly screen: ScreenPresenter;
}

/** What the session hands `try_lines` beside the catalog's step context and presenter. */
export type TryLinesSession = Omit<TryLinesOptions, 'context' | 'screen'>;

interface TryLinesArgs {
  readonly code: string;
  readonly timeout?: number | undefined;
}

/** The rendered result, and whether a statement failed. */
interface TriedLines {
  readonly text: string;
  readonly failed: boolean;
}

/** What became of one statement. */
type Outcome = { readonly statement: Statement; readonly value: unknown } | { readonly statement: Statement; readonly error: E2EError };

/** The `try_lines` catalog tool. */
export function tryLinesTool(options: TryLinesOptions): ToolSet[string] {
  return {
    description: [
      'Try test lines against the live session before writing them into a test.',
      "Pass statements as they appear in a test body, such as await screen.getByLabel('Email').fill('ada@example.com'); await expect(screen.getByRole('status')).toHaveText('Saved').",
      "They run in order on the session's screen and app fixtures with the test API's own waiting, exactly-one rule, and matchers, and stop at the first failure.",
      `The result gives each statement's pass or failure (code and message) and a read's value, then what changed on screen. Each statement waits at most timeout ms (default ${String(TRY_LINES_TIMEOUT_MS)}).`,
      'The code is parsed, never run as JavaScript: a statement starts with screen, app, or expect(locator), chains getBy* queries, filter, first, last, and nth, and ends in an action, a read, or a matcher.',
      "Arguments are literals, regular expressions, arrays, objects, locators on screen, and credentials.user('name').username.",
      "credentials.user('name').password and secrets.get('name') are accepted only as fill's value, and fill only where type_secret would.",
      'While a secret value shows on screen, a regular expression, exact: false, toContainText, or a hasText filter is refused with POLICY_DENIED; match the whole text instead.',
    ].join(' '),
    inputSchema: z.object({
      code: z.string().min(1).describe('One or more test statements, separated by ";" or new lines'),
      timeout: z
        .number()
        .int()
        .min(1)
        .max(MAX_TIMEOUT_MS)
        .optional()
        .describe(`How long each statement may wait, in milliseconds; default ${String(TRY_LINES_TIMEOUT_MS)}`),
    }).strict(),
    execute: (args: TryLinesArgs, call: ToolExecutionOptions<unknown>) => tryLines(options, args, call.abortSignal),
    toModelOutput: ({ output }: { readonly output: TriedLines }) => ({ type: output.failed ? ('error-text' as const) : ('text' as const), value: output.text }),
  };
}

/** Parses the code, runs its statements until one fails, and renders what happened. */
async function tryLines(options: TryLinesOptions, args: TryLinesArgs, signal: AbortSignal | undefined): Promise<TriedLines> {
  const statements = parseLines(args.code, { fixtures: options.engineFixtures });
  const timeout = args.timeout ?? TRY_LINES_TIMEOUT_MS;
  const runner = new LineRunner(options);
  const outcomes: Outcome[] = [];
  for (const statement of statements) {
    if (signal?.aborted === true) break;
    const outcome = await tryStatement(options, runner, statement, timeout);
    outcomes.push(outcome);
    if ('error' in outcome) break;
  }
  let screen: string;
  try {
    screen = options.screen.update(await options.context.observe(), { expectChange: false });
  } catch (cause) {
    screen = `Observing the screen afterwards failed: ${codedMessage(cause)}`;
  }
  const failed = outcomes.some((outcome) => 'error' in outcome);
  return { text: render(statements, outcomes, timeout, options.runtime.redact, screen), failed };
}

/**
 * Runs one statement under the call's cap. A statement that matches part of
 * a text is refused while a secret value shows on screen, and its outcome is
 * withheld when one shows once it ran: either way its pass or fail would say
 * whether that part of the value is on screen.
 */
async function tryStatement(options: TryLinesOptions, runner: LineRunner, statement: Statement, timeout: number): Promise<Outcome> {
  const partial = matchesPart(statement);
  try {
    if (partial && (await secretOnScreen(options.context))) {
      throw partialMatchDenied('it did not run');
    }
    const settled = await options.budget.capped(timeout, () => runner.run(statement)).then(
      (value: unknown) => ({ value }),
      (cause: unknown) => ({ cause }),
    );
    if (partial && (await secretOnScreen(options.context))) {
      throw partialMatchDenied('it ran, and its outcome is withheld');
    }
    if ('cause' in settled) throw settled.cause;
    return { statement, value: settled.value };
  } catch (cause) {
    return { statement, error: classifyError(cause) };
  }
}

/** Whether the redacted screen shows where a secret value is. */
async function secretOnScreen(context: StepExecutorContext): Promise<boolean> {
  return (await context.observe()).text.includes(SECRET_MARKER);
}

function partialMatchDenied(what: string): ConfigurationError {
  return new ConfigurationError(
    'POLICY_DENIED',
    `a secret value is on screen (observe shows ${SECRET_MARKER}name> where it is) and this statement matches part of a text, so ${what}: its pass or fail would tell the value apart a piece at a time. Match the whole text instead, without a regular expression, exact: false, toContainText, or a hasText filter.`,
  );
}

/**
 * Whether a statement matches part of a text: a regular expression,
 * `exact: false`, `toContainText`, or a `hasText` filter, which matches a
 * substring. An exact match only ever confirms a whole value.
 */
function matchesPart(statement: Statement): boolean {
  const { body } = statement;
  const calls = body.kind === 'call' ? body.chain.calls : [...body.locator.calls, body.matcher];
  return calls.some(callMatchesPart);
}

function callMatchesPart(call: Call): boolean {
  return call.name === 'toContainText' || call.args.some((arg) => valueMatchesPart(arg, undefined));
}

function valueMatchesPart(value: Value, key: string | undefined): boolean {
  switch (value.kind) {
    case 'regex':
      return true;
    case 'literal':
      return (key === 'exact' && value.value === false) || (key === 'hasText' && typeof value.value === 'string');
    case 'array':
      return value.items.some((item) => valueMatchesPart(item, undefined));
    case 'object':
      return value.entries.some(([entry, item]) => valueMatchesPart(item, entry));
    case 'locator':
      return value.chain.calls.some(callMatchesPart);
    case 'username':
    case 'secret':
      return false;
  }
}

/** Runs parsed statements on the session's fixtures. */
class LineRunner {
  constructor(private readonly options: TryLinesOptions) {}

  async run(statement: Statement): Promise<unknown> {
    const { body } = statement;
    if (body.kind === 'call') {
      const value: unknown = await this.chain(body.chain);
      return body.read ? value : undefined;
    }
    const expectation: unknown = expect(this.chain(body.locator) as never);
    const matchers: unknown = body.negated ? Reflect.get(expectation as object, 'not') : expectation;
    await this.invoke(matchers, body.matcher);
    return undefined;
  }

  /** Walks a chain from its fixture: a query returns its locator at once, the last call its promise. */
  private chain(chain: Chain): unknown {
    let receiver: unknown = chain.root === 'screen' ? this.options.fixtures.screen : this.options.fixtures.app;
    for (const call of chain.calls) {
      const [first, second] = call.args;
      receiver =
        call.name === 'fill' && first?.kind === 'secret'
          ? this.fillSecret(receiver, this.secret(first), second === undefined ? undefined : this.value(second))
          : this.invoke(receiver, call);
    }
    return receiver;
  }

  /** Calls a member the grammar's table listed by this name, on the object it was listed for. */
  private invoke(receiver: unknown, call: Call): unknown {
    const method: unknown = Reflect.get(receiver as object, call.name);
    if (typeof method !== 'function') {
      throw new ConfigurationError('UNSUPPORTED_CAPABILITY', `${call.name} is not available on this target`);
    }
    return Reflect.apply(method, receiver, call.args.map((arg) => this.value(arg)));
  }

  /** An argument as the fixture receives it; a Secret stays a handle and goes through `fillSecret` only. */
  private value(value: Value): unknown {
    switch (value.kind) {
      case 'literal':
        return value.value;
      case 'regex':
        return new RegExp(value.source, value.flags);
      case 'array':
        return value.items.map((item) => this.value(item));
      case 'object': {
        // Defined, not assigned: a property named like a prototype member stays a plain own property.
        const object = {};
        for (const [key, item] of value.entries) {
          Object.defineProperty(object, key, { value: this.value(item), enumerable: true, writable: true, configurable: true });
        }
        return object;
      }
      case 'locator':
        return this.chain(value.chain);
      case 'username':
        return this.credential(value.credential).username;
      case 'secret':
        throw new TestError('INVALID_ARGUMENT', "a secret is accepted only as fill's value");
    }
  }

  private credential(name: string) {
    const credential = this.options.runtime.config.credentials.get(name);
    if (credential === undefined) {
      throw new ConfigurationError('AUTH_CREDENTIAL_UNAVAILABLE', `credential "${name}" is not configured; add it to config.credentials or E2E_USER_* variables`);
    }
    return credential;
  }

  /** The handle a secret reference names, from the session's own config. */
  private secret(value: Extract<Value, { kind: 'secret' }>): Secret {
    if (value.from === 'credential') return secretHandle(this.credential(value.name).password);
    const secret = this.options.runtime.config.secrets.get(value.name);
    if (secret === undefined) {
      throw new ConfigurationError('SECRET_UNAVAILABLE', `secret "${value.name}" is not configured; add it to config.secrets`);
    }
    return secretHandle(secret);
  }

  /**
   * `locator.fill(secret)` under the authorization `type_secret` runs: a
   * configured secret, an enabled editable field, and a password field for a
   * password, checked on the node the value lands on, every time the locator
   * resolves. A test's own `fill` skips this as trusted code; tried lines
   * come from the coding agent, which is not.
   */
  private fillSecret(receiver: unknown, secret: Secret, options: unknown): Promise<void> {
    const internals = locatorInternals(receiver);
    if (internals === undefined) throw new TestError('INVALID_ARGUMENT', 'fill takes a secret on a locator only');
    rejectUnknownOptions('fill', options as object | undefined, ['timeout']);
    const { runtime } = this.options;
    const host = {
      recordPolicy: (policy: string, decision: 'allowed' | 'denied', code?: string) => recordPolicyEvent(runtime.steps, policy, decision, code),
    };
    const { engine, steps } = internals.context;
    return steps.run('locator', 'locator.fill', describeExpression(internals.expression), () =>
      engine.fillSecret(
        internals.expression,
        async (node) => {
          const plaintext = await authorizeSecretFill(host, runtime, secret, node);
          // Before the engine call: a fill that types the value and then fails has still put it on screen.
          runtime.exposure.raise('filled');
          return plaintext;
        },
        (options as ActionOptions | undefined)?.timeout,
      ),
    );
  }
}

/** The result: a summary, each statement with its outcome, then the screen. */
function render(statements: readonly Statement[], outcomes: readonly Outcome[], timeout: number, redact: (text: string) => string, screen: string): string {
  const failure = outcomes.findIndex((outcome) => 'error' in outcome);
  const total = statements.length;
  const lines: string[] = [];
  if (failure !== -1) {
    const unrun = total - failure - 1;
    lines.push(
      `Statement ${String(failure + 1)} of ${String(total)} failed${failure === 0 ? '' : `; the ${failure === 1 ? 'one' : String(failure)} before it passed`}${unrun === 0 ? '' : `, and ${unrun === 1 ? 'the one' : `the ${String(unrun)}`} after it did not run`}.` +
        ` Each statement waited at most ${String(timeout)} ms.${failure === 0 ? '' : ' The app is where the passing statements left it: try the fixed statement and the rest from here.'}`,
    );
  } else if (outcomes.length < total) {
    lines.push(`Cancelled after ${String(outcomes.length)} of ${String(total)} statements.`);
  } else {
    lines.push(total === 1 ? 'The statement passed.' : `All ${String(total)} statements passed.`);
  }
  statements.forEach((statement, index) => {
    const outcome = outcomes[index];
    const number = `${String(index + 1)}.`;
    if (outcome === undefined) {
      lines.push(`${number} not run: ${statement.source}`);
    } else if ('error' in outcome) {
      lines.push(`${number} failed: ${statement.source}`, indent(`${outcome.error.code}: ${outcome.error.message}`));
    } else {
      lines.push(`${number} passed: ${statement.source}`);
      const value = renderValue(outcome.value, redact);
      if (value !== undefined) lines.push(indent(value));
    }
  });
  return `${lines.join('\n')}\n\n${screen}`;
}

/** A read's value, every string in it passed through the secret ledger before it is quoted. */
function renderValue(value: unknown, redact: (text: string) => string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string' && value.includes('\n')) return `returned:\n${redact(value)}`;
  return `returned ${JSON.stringify(redactStrings(value, redact))}`;
}

function redactStrings(value: unknown, redact: (text: string) => string): unknown {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map((item) => redactStrings(item, redact));
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactStrings(item, redact)]));
  }
  return value;
}

function indent(text: string): string {
  return text.split('\n').map((line) => `   ${line}`).join('\n');
}
