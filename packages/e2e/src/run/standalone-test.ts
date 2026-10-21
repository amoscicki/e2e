/**
 * One collected test run on a standalone attempt: `e2e mcp`'s
 * `open_session {test}`. The test's `beforeAll` and `beforeEach` hooks, its
 * `test.extend()` fixtures, and its body run on the attempt's fixtures under
 * the test's timeout, the way a worker runs them, and the attempt then stays
 * where the body stopped, passed or failed, so a coding agent can look at the
 * screen the test ended on. Teardown (`afterEach` hooks, fixture teardowns,
 * `afterAll` hooks) waits for the attempt's close. The replay cache serves
 * the run as it serves a run's first attempt, settled when the body ends.
 */

import { isModelUnreachable } from '../agent/error.ts';
import { settleStagedTraces, type AgentCacheContext } from '../cache/context.ts';
import { collect, type CollectedFile, type TestIdentity } from '../collect/collect.ts';
import { select, type TestTargetPair } from '../collect/select.ts';
import type { ResolvedConfig, ResolvedTarget } from '../config/resolve.ts';
import type { OperationContext, TargetSession } from '../engine/surface.ts';
import { publishAttempt } from '../expect/attempt.ts';
import { PollScope, runInPollScope } from '../expect/poll-scope.ts';
import { SoftFailures } from '../expect/soft.ts';
import { classifyError, ConfigurationError, E2EError, serializeError, TestTimeoutError, type ErrorPhase, type SerializedError } from '../internal/errors.ts';
import { isRuntimeSkip, type RuntimeSkip } from '../internal/skip.ts';
import { withTimeout, type Deadline } from '../internal/time.ts';
import type { SetupFn } from '../types.ts';
import type { AttemptBudget } from './budget.ts';
import { classifyAttemptStatus, type TargetExecutor } from './execute.ts';
import { createExtendedFixtures, type ExtendedFixtures } from './extended-fixtures.ts';
import { captureFailureEvidence } from './failure-evidence.ts';
import type { ArtifactSink, AttemptFixtures } from './fixtures.ts';
import { findRegistered, runHook, type Realm } from './realm.ts';
import type { FailureEvidence } from './records.ts';
import { sessionSecrecy } from './secrecy.ts';
import type { StepRecord, StepRecorder } from './steps.ts';

/** The test `open_session {test}` runs, as `e2e run`'s collection and selection found it on the session's target. */
export interface StandaloneTest {
  readonly pair: TestTargetPair;
  /** The test's file as collection imported it; the attempt adopts that import as the test's realm. */
  readonly file: CollectedFile;
}

/** Tests a `TEST_AMBIGUOUS` message names before it counts the rest. */
const MAX_LISTED_TESTS = 10;

/**
 * Collects the project the way `e2e run <positional>` does and returns the one
 * test the positional selects on `target`. A positional that selects nothing
 * fails with `e2e run`'s `NO_TESTS` message, one that selects several with
 * `TEST_AMBIGUOUS` listing them, and a test a session cannot run alone with
 * `SESSION_TEST_UNSUPPORTED`: a serial group member, a test that starts from
 * a setup test's saved session, and a test that runs as several agents.
 * `graph` is the module graph the project's files load in, so an edit to a
 * file the test imports is seen by the next session.
 */
export async function selectStandaloneTest(
  config: ResolvedConfig,
  target: ResolvedTarget,
  positional: string,
  graph: string | undefined,
): Promise<StandaloneTest> {
  const collection = await collect(config, [positional], graph);
  const { pairs } = select(collection, config, { targetIds: [target.name] }, { noTestsHint: 'name a test file the config finds, with :line for one test in it' });
  // A serial group's other members run beside a selected one; only what the positional named counts.
  const runnable = pairs.filter((pair) => pair.disposition === 'run' && pair.test.kind === 'test' && pair.test.selected);
  const tests = [...new Map(runnable.map((pair) => [pair.test.id, pair.test])).values()];
  if (tests.length > 1) {
    const listed = tests.slice(0, MAX_LISTED_TESTS).map((test) => `${testLocation(test)} "${test.titlePath.join(' › ')}"`);
    const rest = tests.length - listed.length;
    throw new ConfigurationError(
      'TEST_AMBIGUOUS',
      `"${positional}" selects ${tests.length} tests on target "${target.name}", and a session runs one; name it as file:line: ${listed.join(', ')}${rest > 0 ? `, and ${rest} more` : ''}`,
    );
  }
  const [pair, ...otherAgents] = runnable;
  if (pair === undefined) throw new ConfigurationError('NO_TESTS', `"${positional}" selects no test on target "${target.name}"`);
  const named = `test "${pair.test.titlePath.join(' › ')}" (${testLocation(pair.test)})`;
  if (pair.test.serialId !== undefined) {
    throw unsupported(`${named} is in a serial group, whose tests run in order on one shared attempt; a session runs a test alone, so run the group with npx e2e run`);
  }
  if (pair.options.session !== undefined) {
    throw unsupported(`${named} starts from session "${pair.options.session}", which a setup test saves first; a session does not run setup tests yet, so run it with npx e2e run`);
  }
  if (otherAgents.length > 0) {
    const agents = [pair, ...otherAgents].map((each) => `"${each.agent}"`).join(', ');
    throw unsupported(`${named} runs as agents ${agents}; a session runs one, so run it with npx e2e run`);
  }
  const file = collection.files.find((candidate) => candidate.file === pair.test.file);
  if (file === undefined) throw new ConfigurationError('NO_TESTS', `the file of ${named} was not collected`);
  return { pair, file };
}

/** `tests/a.e2e.ts:12`, the line the test is declared on, or the file alone when the declaration is in a module it imports. */
export function testLocation(test: Pick<TestIdentity, 'file' | 'source'>): string {
  return test.source === undefined ? test.file : `${test.file}:${test.source.line}`;
}

function unsupported(message: string): ConfigurationError {
  return new ConfigurationError('SESSION_TEST_UNSUPPORTED', message);
}

/** What a standalone test run reads of the attempt it runs on. */
interface StandaloneTestEnvironment {
  readonly config: ResolvedConfig;
  readonly target: ResolvedTarget;
  readonly executor: TargetExecutor;
  readonly runId: string;
  readonly attemptId: string;
  readonly session: TargetSession;
  readonly steps: StepRecorder;
  readonly budget: AttemptBudget;
  readonly fixtures: AttemptFixtures['fixtures'];
  readonly artifacts: ArtifactSink;
  readonly cache: AgentCacheContext | undefined;
  /** The attempt's cancellation: the body's budget and every teardown hook's follow it. */
  readonly signal: AbortSignal;
  /** The attempt's deadline, which its budget returns to once the body has ended. */
  readonly deadline: Deadline;
  readonly redact: (text: string) => string;
}

/** How the test's hooks and body ended. */
export interface StandaloneTestOutcome {
  readonly status: 'passed' | 'failed' | 'timed-out' | 'skipped' | 'interrupted';
  readonly error?: SerializedError | undefined;
  /** Failures that landed after the first: a step the body did not await, soft assertions beside a thrown one. */
  readonly secondaryErrors: readonly SerializedError[];
  readonly skipReason?: string | undefined;
  /** What the screen held when the failure landed: the URL, and the nodes nearest a locator that matched nothing. */
  readonly failure?: FailureEvidence | undefined;
  readonly durationMs: number;
  readonly steps: readonly StepRecord[];
}

export interface StandaloneTestRun {
  readonly test: StandaloneTest;
  /** Runs the test's hooks and body, once; the attempt stays where the body stopped. */
  run(): Promise<StandaloneTestOutcome>;
  /**
   * Runs what the body left set up: `afterEach` hooks, fixture teardowns, then
   * `afterAll` hooks. Once, after the run settled; nothing when it never
   * started. Never rejects: every failure is returned, `afterAll`'s through
   * the worker's run errors.
   */
  teardown(): Promise<readonly SerializedError[]>;
}

/** The phases a standalone run moves through before its teardown. */
type RunPhase = 'beforeAll' | 'beforeEach' | 'body';

/** What a run leaves for its teardown: the realm whose scopes it entered, and the `afterEach` hooks then the fixture teardowns, in order. */
interface Started {
  readonly realm: Realm;
  readonly teardowns: readonly { readonly label: string; readonly run: () => Promise<void> | void }[];
}

/**
 * The tail of the chain every standalone test run and teardown takes its turn
 * on. `expect.poll`, `expect.soft`, and `test.skip` find the running attempt
 * through one slot per process (`publishAttempt`), so test code in two
 * sessions of one `e2e mcp` server takes turns rather than overlapping.
 */
let turns: Promise<unknown> = Promise.resolve();

/** Runs `work` once every turn queued before it has settled. */
function takeTurn<T>(work: () => Promise<T>): Promise<T> {
  const turn = turns.then(work, work);
  turns = turn.catch(() => undefined);
  return turn;
}

/** Binds one test to an attempt; nothing runs until `run`. */
export function createStandaloneTestRun(env: StandaloneTestEnvironment, test: StandaloneTest): StandaloneTestRun {
  const { config, executor, steps, budget, attemptId } = env;
  let ran: Promise<Started | undefined> | undefined;
  let tearingDown: Promise<readonly SerializedError[]> | undefined;
  const serialize = (cause: unknown, phase: ErrorPhase): SerializedError =>
    serializeError(classifyError(cause), { phase, projectRoot: config.projectRoot, redact: env.redact });
  const operation = (signal: AbortSignal, timeoutMs: number): OperationContext => ({ signal, timeoutMs, runId: env.runId, attemptId, origin: 'test' });

  const execute = async (): Promise<{ started: Started | undefined; outcome: StandaloneTestOutcome }> => {
    const startedMs = Date.now();
    const { pair } = test;
    const realm = executor.realms.adopt(test.file.registration, test.file);
    const registered = findRegistered(realm, pair.test);
    if (registered === undefined) throw new ConfigurationError('COLLECTION_ERROR', `test ${pair.test.id} is no longer registered by ${pair.test.file}`);
    const secondaryErrors: SerializedError[] = [];
    let failure: E2EError | undefined;
    let failurePhase: RunPhase = 'beforeAll';
    let skipped: RuntimeSkip | undefined;
    let timedOut = false;
    // As in a run's attempt: confirmation stops at what was verified when the
    // failure landed, and a failure only a missing model explains implicates nothing.
    let lastVerifiedAtFailure = -1;
    let implicatesUnconfirmed = false;
    const fail = (cause: unknown, phase: RunPhase): void => {
      const classified = classifyError(cause);
      if (!isModelUnreachable(classified)) implicatesUnconfirmed = true;
      if (failure !== undefined) {
        secondaryErrors.push(serialize(classified, phase));
        return;
      }
      lastVerifiedAtFailure = steps.lastVerifiedStepIndex;
      failure = classified;
      failurePhase = phase;
    };

    const hookFailure = await executor.realms.enterScopes(realm, registered);
    let extended: ExtendedFixtures | undefined;
    if (hookFailure !== undefined) {
      fail(new E2EError('test', hookFailure.code, hookFailure.message), 'beforeAll');
    } else {
      // The test's own timeout bounds its hooks and body; the session's deadline comes back after.
      const bodyAbort = budget.enter(env.signal, pair.options.timeout);
      const soft = new SoftFailures();
      const polls = new PollScope('the test body');
      const publication = new AbortController();
      publishAttempt({ attemptId, owner: 'host', testKind: 'test', assertionTimeout: config.assertionTimeout, budget, soft, polls }, publication.signal);
      // Whatever happens below, the slot is free for the next test once the body is done.
      try {
        extended = createExtendedFixtures(registered.fixtures, env.fixtures, env.target.engine?.name ?? 'none', budget.signal);
        const fixtures = extended;
        let phase: RunPhase = 'beforeEach';
        const enter = (next: RunPhase): void => {
          phase = next;
          steps.phase = next === 'beforeEach' ? 'beforeEach' : undefined;
        };
        /** Steps and polls the body left running, failed at their call and cancelled; see `executeAttempt`. */
        const abandonNotAwaited = async (): Promise<E2EError[]> => {
          const pollsNotAwaited = polls.close();
          const stepsNotAwaited = steps.abandonRunning();
          if (stepsNotAwaited !== undefined) {
            bodyAbort.abort();
            await withTimeout(steps.settleAbandoned(), config.cleanupTimeout, () => new Error('abandoned steps did not settle')).catch(() => undefined);
          }
          return [stepsNotAwaited, pollsNotAwaited].filter((error) => error !== undefined);
        };
        const mainWork = async (): Promise<void> => {
          try {
            enter('beforeEach');
            await fixtures.setUp();
            budget.signal.throwIfAborted();
            for (const hook of executor.realms.hooksFor(realm, registered, 'beforeEach')) {
              await hook.fn(env.fixtures);
              budget.signal.throwIfAborted();
            }
            enter('body');
            await (registered.fn as SetupFn)(env.fixtures);
          } catch (cause) {
            const notAwaited = await abandonNotAwaited();
            if (isRuntimeSkip(cause)) throw cause;
            for (const secondary of [...notAwaited, soft.close()]) if (secondary !== undefined) secondaryErrors.push(serialize(secondary, 'body'));
            throw cause;
          }
          const [notAwaited, ...moreNotAwaited] = await abandonNotAwaited();
          for (const secondary of moreNotAwaited) secondaryErrors.push(serialize(secondary, 'body'));
          if (notAwaited !== undefined) throw notAwaited;
          const softFailure = soft.close();
          if (softFailure !== undefined) throw softFailure;
        };
        try {
          await withTimeout(runInPollScope(polls, mainWork), Math.max(1, pair.options.timeout), () => {
            timedOut = true;
            bodyAbort.abort();
            return new TestTimeoutError(`test timed out after ${pair.options.timeout} ms in phase ${phase}`);
          });
        } catch (cause) {
          polls.close();
          if (isRuntimeSkip(cause)) skipped = cause;
          else fail(cause, phase);
        }
        // A rejection the body left unawaited lands once the microtasks drain.
        await new Promise<void>((resolve) => setImmediate(resolve));
        const lateSoft = soft.close();
        if (lateSoft !== undefined) fail(lateSoft, 'body');
        // A callback the engine ran for the body (a route handler) fails on a path no step awaits.
        try {
          await executor.settleAttempt(env.session, attemptId);
        } catch (cause) {
          fail(cause, 'body');
        }
      } finally {
        steps.phase = undefined;
        publication.abort();
      }
    }

    const interrupted = env.signal.aborted;
    const status: StandaloneTestOutcome['status'] =
      failure === undefined ? (skipped === undefined ? 'passed' : 'skipped') : classifyAttemptStatus(failure, timedOut, interrupted);
    let evidence: FailureEvidence | undefined;
    if (failure !== undefined && !interrupted) {
      evidence = await captureFailureEvidence({
        session: env.session,
        error: failure,
        secrecy: sessionSecrecy(env.session, config.allSecrets),
        config,
        appOrigin: env.target.app.base?.origin,
        artifacts: env.artifacts,
        operation,
        interrupt: env.signal,
      }).catch(() => undefined);
    }
    if (env.cache !== undefined) {
      await settleStagedTraces(
        env.cache,
        status === 'interrupted'
          ? undefined
          : {
              lastVerifiedStepIndex: failure === undefined ? steps.lastVerifiedStepIndex : lastVerifiedAtFailure,
              implicatesUnconfirmed: failure === undefined || implicatesUnconfirmed,
            },
      );
    }
    // The attempt goes on as the session: its budget is the session's again.
    budget.enter(env.signal, Math.max(1, env.deadline.remaining()));
    const outcome: StandaloneTestOutcome = {
      status,
      ...(failure === undefined ? {} : { error: serialize(failure, failurePhase) }),
      secondaryErrors,
      ...(skipped === undefined ? {} : { skipReason: skipped.reason }),
      ...(evidence === undefined ? {} : { failure: evidence }),
      durationMs: Date.now() - startedMs,
      steps: [...steps.all()],
    };
    const teardowns =
      extended === undefined
        ? []
        : [
            ...executor.realms.hooksFor(realm, registered, 'afterEach').map((hook) => ({ label: `${hook.kind} hook`, run: () => hook.fn(env.fixtures) })),
            ...extended.teardowns().map((teardown) => ({ label: `fixture "${teardown.name}" teardown`, run: teardown.run })),
          ];
    return { started: { realm, teardowns }, outcome };
  };

  const run = (): Promise<StandaloneTestOutcome> => {
    if (ran !== undefined) return Promise.reject(new ConfigurationError('WORKER_PROTOCOL', 'the session already ran its test'));
    if (tearingDown !== undefined) return Promise.reject(new ConfigurationError('NO_SESSION', 'the session closed before its test ran'));
    const executed = takeTurn(execute);
    ran = executed.then((result) => result.started, () => undefined);
    return executed.then((result) => result.outcome);
  };

  const teardown = (): Promise<readonly SerializedError[]> => {
    tearingDown ??= (async () => {
      const started = await ran;
      if (started === undefined) return [];
      return takeTurn(async () => {
        const errors: SerializedError[] = [];
        const soft = new SoftFailures();
        // As after a run's body: a soft matcher in a teardown hook finds the collection closed.
        soft.close();
        const publication = new AbortController();
        publishAttempt({ attemptId, owner: 'host', testKind: 'test', assertionTimeout: config.assertionTimeout, budget, soft, polls: new PollScope('the test teardown') }, publication.signal);
        steps.phase = 'afterEach';
        try {
          // Each teardown gets its own cleanup budget, as in a run's attempt.
          for (const hook of started.teardowns) {
            const hookAbort = budget.enter(env.signal, config.cleanupTimeout);
            try {
              await runHook(hook.label, hook.run, config.cleanupTimeout, () => hookAbort.abort());
            } catch (cause) {
              errors.push(serialize(cause, 'afterEach'));
            }
          }
          await executor.settleAttempt(env.session, attemptId).catch((cause: unknown) => errors.push(serialize(cause, 'afterEach')));
        } finally {
          steps.phase = undefined;
          publication.abort();
        }
        await executor.realms.leave(started.realm).catch((cause: unknown) => errors.push(serialize(cause, 'afterAll')));
        return errors;
      }).catch((cause: unknown) => [serialize(cause, 'cleanup')]);
    })();
    return tearingDown;
  };

  return { test, run, teardown };
}
