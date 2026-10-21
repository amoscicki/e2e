/**
 * The `try_lines` grammar: test statements as a test body writes them parse
 * into plain data, and anything outside the grammar is refused with the
 * token and where it sits, before anything could run. The parser never
 * reaches for `eval` or `Function`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseLines, type Statement } from '../../src/mcp/lines-parse.ts';

/** A target whose engine contributes a `browser` fixture, as the web engine's does. */
const WEB = { fixtures: ['browser'] } as const;

const ARGUMENTS =
  "an argument is a string, number, boolean, null, regular expression, array, or object, a locator on screen, credentials.user('name').username, or a secret as fill's value";
const STATEMENTS = 'a statement starts with screen, app, or expect(...)';
const LOCATOR_MEMBERS =
  'getByRole, getByLabel, getByPlaceholder, getByText, getByDisplayValue, getByTestId, tapAt, swipe, scrollUntilVisible, filter, first, last, nth, tap, click, doubleTap, dblclick, secondaryTap, longPress, fill, pressSequentially, clear, press, check, uncheck, selectOption, focus, hover, dragTo, scrollIntoView, waitFor, textContent, inputValue, getAttribute, isVisible, isHidden, isEnabled, isDisabled, isChecked, boundingBox, count, allTextContents';
const NESTED = 'repeats a group that repeats or alternates inside, which can run for hours on a short text; repeat a single character or class instead';
const SECRET_PLACE = "is accepted only as fill's value, such as screen.getByLabel('Password').fill(credentials.user('admin').password)";

/** The message `try_lines` refuses `code` with. */
function refusal(code: string, options: { readonly fixtures: readonly string[] } = WEB): string {
  try {
    parseLines(code, options);
  } catch (cause) {
    expect(cause).toMatchObject({ code: 'INVALID_ARGUMENT' });
    return (cause as Error).message;
  }
  throw new Error(`parsed: ${code}`);
}

describe('parseLines accepts', () => {
  it('the statements of a test body, each as written and as data', () => {
    const statements = parseLines(
      `await screen.getByLabel('Full name').fill('Grace Hopper');
await screen.getByRole('button', 'Save profile').tap();
await expect(screen.getByRole('status', 'Save result')).toHaveText('Saved profile for Grace Hopper');`,
      WEB,
    );
    expect(statements.map((statement) => statement.source)).toEqual([
      "await screen.getByLabel('Full name').fill('Grace Hopper');",
      "await screen.getByRole('button', 'Save profile').tap();",
      "await expect(screen.getByRole('status', 'Save result')).toHaveText('Saved profile for Grace Hopper');",
    ]);
    expect(statements[0]!.body).toEqual({
      kind: 'call',
      read: false,
      chain: {
        root: 'screen',
        calls: [
          { name: 'getByLabel', args: [{ kind: 'literal', value: 'Full name' }] },
          { name: 'fill', args: [{ kind: 'literal', value: 'Grace Hopper' }] },
        ],
      },
    });
    expect(statements[2]!.body).toEqual({
      kind: 'expect',
      negated: false,
      locator: { root: 'screen', calls: [{ name: 'getByRole', args: [{ kind: 'literal', value: 'status' }, { kind: 'literal', value: 'Save result' }] }] },
      matcher: { name: 'toHaveText', args: [{ kind: 'literal', value: 'Saved profile for Grace Hopper' }] },
    });
  });

  it('statements without await or semicolons, chains over several lines, comments, and trailing commas, echoed on one line without the comments', () => {
    const statements = parseLines(
      `// open the form
app.open('/forms')
screen
  .getByRole('listitem') // the rows
  .filter({ hasText: 'Ada', }) /* the first row */
  .first()
  .tap({ timeout: 2000, },)
screen.getByLabel('Notes').fill(\`line one
  .two\`)`,
      WEB,
    );
    expect(statements.map((statement) => statement.source)).toEqual([
      "app.open('/forms')",
      "screen.getByRole('listitem').filter({ hasText: 'Ada', }).first().tap({ timeout: 2000, },)",
      "screen.getByLabel('Notes').fill(`line one\n  .two`)",
    ]);
    expect(statements[1]!.body).toMatchObject({
      kind: 'call',
      chain: { calls: [{ name: 'getByRole' }, { name: 'filter' }, { name: 'first', args: [] }, { name: 'tap', args: [{ kind: 'object', entries: [['timeout', { kind: 'literal', value: 2000 }]] }] }] },
    });
    expect(statements[2]!.body).toMatchObject({ chain: { calls: [{}, { name: 'fill', args: [{ value: 'line one\n  .two' }] }] } });
  });

  it('every kind of argument: literals, regexes, templates, arrays, objects, nested locators, and credential and secret references', () => {
    const [drag, filter, numbers, fill, secret, username, key] = parseLines(
      `await screen.getByText(/^Card \\d+$/i).dragTo(screen.getByTestId("lane-done"));
await screen.getByRole('row').filter({ has: screen.getByText(\`Ada\`), 'hasText': 'Lovelace' }).nth(-1).check();
await expect(screen.getByRole('slider')).toHaveAttribute('aria-valuenow', '2.5e1', { ignoreCase: true });
await screen.getByLabel('Password').fill(credentials.user('admin').password);
await screen.getByLabel('Token').fill(secrets.get('apiKey'), { timeout: 1000 });
await screen.getByLabel('Username').fill(credentials.user('admin').username);
await screen.getByRole('textbox', { name: 'Notes', exact: null, level: [1, false] }).press('Enter');`,
      WEB,
    );
    expect(drag!.body).toMatchObject({
      chain: {
        calls: [
          { name: 'getByText', args: [{ kind: 'regex', source: '^Card \\d+$', flags: 'i' }] },
          { name: 'dragTo', args: [{ kind: 'locator', chain: { root: 'screen', calls: [{ name: 'getByTestId', args: [{ kind: 'literal', value: 'lane-done' }] }] } }] },
        ],
      },
    });
    expect(filter!.body).toMatchObject({
      chain: {
        calls: [
          {},
          { name: 'filter', args: [{ kind: 'object', entries: [['has', { kind: 'locator' }], ['hasText', { kind: 'literal', value: 'Lovelace' }]] }] },
          { name: 'nth', args: [{ kind: 'literal', value: -1 }] },
          { name: 'check' },
        ],
      },
    });
    expect(numbers!.body).toMatchObject({ kind: 'expect', matcher: { name: 'toHaveAttribute', args: [{}, { value: '2.5e1' }, { kind: 'object' }] } });
    expect(fill!.body).toMatchObject({ chain: { calls: [{}, { name: 'fill', args: [{ kind: 'secret', from: 'credential', name: 'admin' }] }] } });
    expect(secret!.body).toMatchObject({ chain: { calls: [{}, { name: 'fill', args: [{ kind: 'secret', from: 'secrets', name: 'apiKey' }, { kind: 'object' }] }] } });
    expect(username!.body).toMatchObject({ chain: { calls: [{}, { name: 'fill', args: [{ kind: 'username', credential: 'admin' }] }] } });
    expect(key!.body).toMatchObject({
      chain: {
        calls: [
          { args: [{}, { kind: 'object', entries: [['name', { value: 'Notes' }], ['exact', { value: null }], ['level', { kind: 'array', items: [{ value: 1 }, { value: false }] }]] }] },
          { name: 'press' },
        ],
      },
    });
  });

  it('string escapes as JavaScript decodes them', () => {
    const [statement] = parseLines(String.raw`screen.getByText('it\'s \u00e9\x41\u{1F600} \q "ok"\n').tap()`, WEB);
    expect(statement!.body).toMatchObject({ chain: { calls: [{ args: [{ value: 'it\'s éA😀 q "ok"\n' }] }, {}] } });
  });

  it('reads, which show their value, and actions, which do not', () => {
    const [read, action] = parseLines("await screen.getByTestId('count').textContent(); await app.open('/')", WEB);
    expect(read!.body).toMatchObject({ kind: 'call', read: true });
    expect(action!.body).toMatchObject({ kind: 'call', read: false });
  });

  it('regular expressions that repeat a plain group, a class, or a character', () => {
    const statements = parseLines(
      String.raw`await expect(screen.getByRole('status')).toHaveText(/^Order \d+ of \d+$/);
await expect(screen.getByRole('status')).toHaveText(/(ab)?c+(?<word>\w)+[(*+]+x{2,}/u);`,
      WEB,
    );
    expect(statements).toHaveLength(2);
  });

  it('a matcher negated once', () => {
    const [negated] = parseLines("await expect(screen.getByRole('dialog')).not.toBeVisible({ timeout: 100 })", WEB);
    expect(negated!.body).toMatchObject({ kind: 'expect', negated: true, matcher: { name: 'toBeVisible' } });
  });
});

describe('parseLines refuses', () => {
  it.each([
    ['process.exit()', `try_lines: "process" at 1:1 is not in the grammar; ${STATEMENTS}`],
    ["import fs from 'node:fs'", `try_lines: "import" at 1:1 is not in the grammar; ${STATEMENTS}`],
    ["const name = await screen.getByLabel('Name').inputValue()", `try_lines: "const" at 1:1 is not in the grammar; ${STATEMENTS}`],
    ['await page.goto("/")', `try_lines: "page" at 1:7 is not in the grammar; ${STATEMENTS}`],
    ["screen.getByLabel('Name').fill(process.env.TOKEN)", `try_lines: "process" at 1:32 is not in the grammar; ${ARGUMENTS}`],
    ["screen.getByRole('row').filter(() => true).tap()", `try_lines: unexpected "(" at 1:32; ${ARGUMENTS}`],
    ["screen.getByRole('row').filter({ hasText: 'a' + 'b' }).tap()", 'try_lines: expected "," or "}" in the object, found "+" at 1:47'],
    ["x = screen.getByText('a')", `try_lines: "x" at 1:1 is not in the grammar; ${STATEMENTS}`],
    ["screen.getByText('a').tap() = 1", 'try_lines: expected ";" or a new line after the statement, found "=" at 1:29'],
    ["screen['getByText']('a').tap()", 'try_lines: expected ";" or a new line after the statement, found "[" at 1:7'],
    ["screen.getByText('a').tap() screen.getByText('b').tap()", 'try_lines: expected ";" or a new line after the statement, found "screen" at 1:29'],
    ["await browser.evaluate('document.cookie')", `try_lines: "browser" at 1:7 is a fixture of this target's engine, which try_lines does not run; ${STATEMENTS}`],
    ["await expect(browser).toHaveURL('/')", `try_lines: "browser" at 1:14 is a fixture of this target's engine, which try_lines does not run; ${STATEMENTS}`],
    ["await expect(screen).toHaveScreenshot('home')", 'try_lines: expect(screen) at 1:14 only compares screenshots, which run in a test; look with the screenshot tool'],
    ["await expect(screen.getByRole('main')).toHaveScreenshot()", 'try_lines: "toHaveScreenshot" at 1:40 is left out of try_lines: it compares against screenshots kept beside a test file, so it runs only in a test; look with the screenshot tool'],
    ["await app.screenshot('after')", 'try_lines: "screenshot" at 1:11 is left out of try_lines: it writes an unmasked screenshot file; use the screenshot tool, which withholds pixels after a secret fill'],
    ["screen.getByLabel('Upload').setInputFiles('/etc/passwd')", 'try_lines: "setInputFiles" at 1:29 is left out of try_lines: it reads files from disk; attach files with the upload tool, which checks the paths'],
    ['screen.debug()', "try_lines: \"debug\" at 1:8 is left out of try_lines: it prints to the server's own output; read the screen with screen.tree() or the observe tool"],
    ["screen.getByRol('button').tap()", 'try_lines: "getByRol" at 1:8 is not something try_lines runs on screen; did you mean "getByRole"?'],
    ['app.launch()', 'try_lines: "launch" at 1:5 is not something try_lines runs on app; app takes open, restart, clearState, back'],
    ["screen.getByText('a').constructor('return 1')()", `try_lines: "constructor" at 1:23 is not something try_lines runs on a locator; a locator takes ${LOCATOR_MEMBERS}`],
    ["screen.getByText('a').__proto__.tap()", `try_lines: "__proto__" at 1:23 is not something try_lines runs on a locator; a locator takes ${LOCATOR_MEMBERS}`],
    ["screen.getByRole('button')", 'try_lines: the statement at 1:1 ends on a locator; end it with an action or a read, or wrap the locator in expect(...)'],
    ["screen.getByRole('button').tap(1, 2)", 'try_lines: tap at 1:28 on a locator takes 0 to 1 arguments, got 2'],
    ['screen.getByRole()', 'try_lines: getByRole at 1:8 on screen takes 1 to 3 arguments, got 0'],
    ["screen.getByText('a').tap().then(done)", 'try_lines: nothing may follow tap(...); found "." at 1:28'],
    ["screen.getByText('a').toBeVisible()", 'try_lines: "toBeVisible" at 1:23 is a matcher; call it on expect(...)'],
    ["expect.soft(screen.getByText('a')).toBeVisible()", 'try_lines: expect.soft at 1:1 is not in the grammar; try_lines runs expect(...) itself, not expect.soft or expect.poll'],
    ["expect(await screen.getByText('a').count()).toBe(1)", 'try_lines: expect takes a locator on screen, found "await" at 1:8'],
    ["expect(screen.getByText('a').count()).toBe(1)", "try_lines: the locator at 1:8 ends in a call; pass the locator itself, such as screen.getByText('Done')"],
    ["expect(screen.getByText('a')).not.not.toBeVisible()", 'try_lines: "not" at 1:35: a matcher is negated once'],
    [
      "expect(screen.getByText('a')).toBe('a')",
      'try_lines: "toBe" at 1:31 is not something try_lines runs on expect(locator); expect(locator) takes toBeVisible, toBeHidden, toBeAttached, toBeEnabled, toBeDisabled, toBeChecked, toBeSelected, toBeExpanded, toBeFocused, toHaveText, toContainText, toHaveValue, toHaveAttribute, toHaveCount, toHaveAccessibleName',
    ],
    ["screen.getByLabel('Email').pressSequentially(credentials.user('admin').password)", `try_lines: the secret at 1:46 ${SECRET_PLACE}`],
    ["expect(screen.getByLabel('Token')).toHaveValue(secrets.get('apiKey'))", `try_lines: the secret at 1:48 ${SECRET_PLACE}`],
    ["screen.getByLabel('Token').fill({ value: secrets.get('apiKey') })", `try_lines: the secret at 1:42 ${SECRET_PLACE}`],
    ["screen.getByLabel('Name').fill('a', secrets.get('apiKey'))", `try_lines: the secret at 1:37 ${SECRET_PLACE}`],
    ["screen.getByLabel('Name').fill(credentials.user(name).username)", 'try_lines: credentials.user takes the name as a string, found "name" at 1:49'],
    ["screen.getByLabel('Name').fill(credentials.user('admin').token)", 'try_lines: "token" at 1:58: a credential has username and password'],
    ['screen.getByLabel(\'Name\').fill(`Hi ${name}`)', 'try_lines: the template at 1:32 has a ${...} expression at 1:36; try_lines runs no expressions, so write the text out'],
    ["screen.getByRole('row').filter({ __proto__: { hasText: 'x' } }).tap()", 'try_lines: the property name "__proto__" at 1:34 is not allowed'],
    ["screen.getByRole('row').filter({ hasText: 'a', hasText: 'b' }).tap()", 'try_lines: the property "hasText" at 1:48 is named twice'],
    ["screen.getByRole('row').filter({ hasText }).tap()", 'try_lines: expected ":" after the property name "hasText", found "}" at 1:42'],
    ['screen.getByRole("row").nth(0x1).tap()', 'try_lines: the number at 1:29 is not a plain decimal number'],
    ['screen.getByText(/(/).tap()', 'try_lines: the regular expression at 1:18 is invalid: Invalid regular expression: /(/: Unterminated group'],
    [String.raw`expect(screen.getByTestId('log')).toHaveText(/^(\w+\s?)*$/)`, `try_lines: the regular expression at 1:46 ${NESTED}`],
    [String.raw`expect(screen.getByTestId('log')).toHaveText(/(?:\s*(a|ab))+/)`, `try_lines: the regular expression at 1:46 ${NESTED}`],
    [String.raw`expect(screen.getByTestId('log')).toHaveText(/(x|y){2,}/)`, `try_lines: the regular expression at 1:46 ${NESTED}`],
    ["screen.getByText('a).tap()", 'try_lines: the string at 1:18 never ends'],
    ["screen.getByText('a').tap() /* trailing", 'try_lines: the comment at 1:29 never ends'],
    ['screen.getByText("é").tap() \\', 'try_lines: unexpected character "\\\\" at 1:29'],
    ['await', `try_lines: expected a statement, found the end of the code at 1:6; ${STATEMENTS}`],
    ['  ;; // nothing', "try_lines: no statement to try; pass test lines such as await screen.getByRole('button', 'Save').tap();"],
  ])('%s', (code, message) => {
    expect(refusal(code)).toBe(message);
  });

  it('a name only as an engine fixture where the target has one', () => {
    expect(refusal("await device.openLink('app://home')", { fixtures: ['device'] })).toBe(
      `try_lines: "device" at 1:7 is a fixture of this target's engine, which try_lines does not run; ${STATEMENTS}`,
    );
    expect(refusal("await browser.goto('/')", { fixtures: [] })).toBe(`try_lines: "browser" at 1:7 is not in the grammar; ${STATEMENTS}`);
  });

  it('positions on later lines', () => {
    expect(refusal("await app.open('/');\n  await fetch('/api/reset');")).toBe(`try_lines: "fetch" at 2:9 is not in the grammar; ${STATEMENTS}`);
  });

  it('more statements, more code, or deeper nesting than one call takes', () => {
    expect(refusal('app.back();'.repeat(51))).toBe('try_lines: try at most 50 statements at once');
    expect(refusal(`screen.getByText('${'a'.repeat(20_000)}').tap()`)).toBe('try_lines: the code is 20026 characters; try at most 20000 at once');
    expect(refusal(`screen.getByText(${'['.repeat(20)}${']'.repeat(20)}).tap()`)).toBe('try_lines: the argument at 1:34 nests deeper than 16 levels');
  });
});

describe('parseLines evaluates nothing', () => {
  const evaluators = ['eval', 'Function'] as const;
  const real = new Map(evaluators.map((name) => [name, Reflect.get(globalThis, name) as unknown]));
  const forbidden = (): never => {
    throw new Error('the parser reached for code evaluation');
  };

  beforeEach(() => {
    for (const name of evaluators) Reflect.set(globalThis, name, forbidden);
  });

  afterEach(() => {
    for (const name of evaluators) Reflect.set(globalThis, name, real.get(name));
  });

  it('parses into JSON data, with eval and Function out of reach', () => {
    const statements: readonly Statement[] = parseLines(
      `await screen.getByRole('row').filter({ has: screen.getByText(/Ada/) }).first().tap();
await expect(screen.getByLabel('Password')).not.toBeFocused();
await screen.getByLabel('Password').fill(credentials.user('admin').password);`,
      WEB,
    );
    expect(JSON.parse(JSON.stringify(statements))).toEqual(statements);
  });

  it('leaves code that would run something unrun, and refuses it', () => {
    const marker = '__try_lines_ran__';
    for (const code of [
      `globalThis.${marker} = true`,
      `screen.getByText('a').constructor.constructor('globalThis.${marker} = true')()`,
      `screen.getByText(\`\${globalThis.${marker} = true}\`).tap()`,
      `screen.getByText((() => { globalThis.${marker} = true })()).tap()`,
    ]) {
      expect(refusal(code)).toMatch(/^try_lines: /);
    }
    expect(Reflect.get(globalThis, marker)).toBeUndefined();
  });
});
