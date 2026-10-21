/**
 * What `try_lines` may call, by receiver: the queries, actions, reads, and
 * matchers of the public test API (`types.ts`), each with the number of
 * arguments it takes. The table is closed: a name it does not list is refused
 * while the code is parsed, so the runner only ever reaches a fixture member
 * by a name listed here. The `browser` rows name the web engine's fixture by
 * its public method names; core imports nothing of the engine for them.
 */

import type { App, AsyncExpectation, Locator, Screen, ScreenExpectation } from '../types.ts';

/** Something a statement can call members on. */
export type Receiver =
  | 'screen'
  | 'locator'
  | 'app'
  | 'browser'
  | 'keyboard'
  | 'locator-expectation'
  | 'screen-expectation'
  | 'browser-expectation';

/** How many arguments a call takes: the fewest and the most. */
export type Arity = readonly [min: number, max: number];

/**
 * One member: a query that leads to a locator, a property that leads to
 * another receiver (`browser.keyboard`), or a call that ends the statement: an
 * action, a read whose value the result shows, or a matcher.
 */
export type Member =
  | { readonly kind: 'query'; readonly args: Arity }
  | { readonly kind: 'namespace'; readonly leads: Receiver }
  | { readonly kind: 'action'; readonly args: Arity; readonly secretValue?: true }
  | { readonly kind: 'read'; readonly args: Arity }
  | { readonly kind: 'matcher'; readonly args: Arity };

const query = (min: number, max: number): Member => ({ kind: 'query', args: [min, max] });
const action = (min: number, max: number): Member => ({ kind: 'action', args: [min, max] });
const read = (min: number, max: number): Member => ({ kind: 'read', args: [min, max] });
const matcher = (min: number, max: number): Member => ({ kind: 'matcher', args: [min, max] });

/** Members named after a public interface, so a name the interface lacks fails to compile. */
function members<T>(entries: { readonly [K in keyof T & string]?: Member }): ReadonlyMap<string, Member> {
  return new Map(Object.entries(entries).filter((entry): entry is [string, Member] => entry[1] !== undefined));
}

const QUERIES = {
  getByRole: query(1, 3),
  getByLabel: query(1, 2),
  getByPlaceholder: query(1, 2),
  getByText: query(1, 2),
  getByDisplayValue: query(1, 2),
  getByTestId: query(1, 2),
} as const satisfies { readonly [K in keyof Screen]?: Member };

const SCREEN_ACTIONS = {
  tapAt: action(1, 2),
  swipe: action(1, 1),
  scrollUntilVisible: action(1, 2),
} as const satisfies { readonly [K in keyof Screen]?: Member };

const SCREEN = members<Screen>({ ...QUERIES, ...SCREEN_ACTIONS, tree: read(0, 1) });

const LOCATOR = members<Locator>({
  ...QUERIES,
  ...SCREEN_ACTIONS,
  filter: query(1, 1),
  first: query(0, 0),
  last: query(0, 0),
  nth: query(1, 1),
  tap: action(0, 1),
  click: action(0, 1),
  doubleTap: action(0, 1),
  dblclick: action(0, 1),
  secondaryTap: action(0, 1),
  longPress: action(0, 1),
  fill: { kind: 'action', args: [1, 2], secretValue: true },
  pressSequentially: action(1, 2),
  clear: action(0, 1),
  press: action(1, 2),
  check: action(0, 1),
  uncheck: action(0, 1),
  selectOption: action(1, 2),
  focus: action(0, 1),
  hover: action(0, 1),
  dragTo: action(1, 2),
  scrollIntoView: action(0, 1),
  waitFor: action(0, 1),
  textContent: read(0, 0),
  inputValue: read(0, 0),
  getAttribute: read(1, 1),
  isVisible: read(0, 0),
  isHidden: read(0, 0),
  isEnabled: read(0, 0),
  isDisabled: read(0, 0),
  isChecked: read(0, 0),
  boundingBox: read(0, 0),
  count: read(0, 0),
  allTextContents: read(0, 0),
});

const APP = members<App>({
  open: action(0, 1),
  restart: action(0, 0),
  clearState: action(0, 0),
  back: action(0, 0),
  screenshot: read(0, 1),
});

const BROWSER: ReadonlyMap<string, Member> = new Map<string, Member>([
  ['goto', action(1, 2)],
  ['reload', action(0, 1)],
  ['back', action(0, 1)],
  ['forward', action(0, 1)],
  ['url', read(0, 0)],
  ['title', read(0, 0)],
  ['waitForURL', action(1, 2)],
  ['keyboard', { kind: 'namespace', leads: 'keyboard' }],
]);

const KEYBOARD: ReadonlyMap<string, Member> = new Map<string, Member>([
  ['press', action(1, 1)],
  ['down', action(1, 1)],
  ['up', action(1, 1)],
  ['type', action(1, 1)],
]);

const LOCATOR_MATCHERS = members<AsyncExpectation>({
  toBeVisible: matcher(0, 1),
  toBeHidden: matcher(0, 1),
  toBeAttached: matcher(0, 1),
  toBeEnabled: matcher(0, 1),
  toBeDisabled: matcher(0, 1),
  toBeChecked: matcher(0, 1),
  toBeSelected: matcher(0, 1),
  toBeExpanded: matcher(0, 1),
  toBeFocused: matcher(0, 1),
  toHaveText: matcher(1, 2),
  toContainText: matcher(1, 2),
  toHaveValue: matcher(1, 2),
  toHaveAttribute: matcher(1, 3),
  toHaveCount: matcher(1, 2),
  toHaveAccessibleName: matcher(1, 2),
  toHaveScreenshot: matcher(0, 2),
});

const SCREEN_MATCHERS = members<ScreenExpectation>({ toHaveScreenshot: matcher(0, 2) });

const BROWSER_MATCHERS: ReadonlyMap<string, Member> = new Map<string, Member>([
  ['toHaveURL', matcher(1, 2)],
  ['toHaveTitle', matcher(1, 2)],
  ['toHaveClass', matcher(2, 3)],
]);

/** Every receiver's members. */
export const SURFACE: Readonly<Record<Receiver, ReadonlyMap<string, Member>>> = {
  screen: SCREEN,
  locator: LOCATOR,
  app: APP,
  browser: BROWSER,
  keyboard: KEYBOARD,
  'locator-expectation': LOCATOR_MATCHERS,
  'screen-expectation': SCREEN_MATCHERS,
  'browser-expectation': BROWSER_MATCHERS,
};

/** A receiver as a message names it. */
export const RECEIVER_LABELS: Readonly<Record<Receiver, string>> = {
  screen: 'screen',
  locator: 'a locator',
  app: 'app',
  browser: 'browser',
  keyboard: 'browser.keyboard',
  'locator-expectation': 'expect(locator)',
  'screen-expectation': 'expect(screen)',
  'browser-expectation': 'expect(browser)',
};

/**
 * Public members `try_lines` leaves out on purpose, with why. Each would run
 * code, take a function or a selector, read files, or print where nobody reads.
 */
export const LEFT_OUT: ReadonlyMap<string, string> = new Map([
  ['debug', 'prints to the server\'s own output; read the screen with screen.tree() or the observe tool'],
  ['all', 'returns locators, not a result; use count() or nth(i)'],
  ['setInputFiles', 'reads files from disk; attach files with the upload tool, which checks the paths'],
  ['locator', 'takes a CSS or XPath selector; try a semantic query such as getByRole or getByLabel'],
  ['frameLocator', 'takes a CSS or XPath selector; try_lines reaches the top document only'],
  ['evaluate', 'runs code in the page, which try_lines never does'],
  ['addInitScript', 'runs code in the page, which try_lines never does'],
  ['route', 'takes a function, which try_lines never runs'],
  ['onDialog', 'takes a function, which try_lines never runs'],
  ['waitForDownload', 'takes a function, which try_lines never runs'],
]);
