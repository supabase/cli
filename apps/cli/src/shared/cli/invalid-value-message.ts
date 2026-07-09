// Workaround for a doubled "Expected: Expected ..." prefix in
// effect@4.0.0-beta.93's own primitive parsers. Several `Primitive`s under
// `effect/unstable/cli` (`choice` — used by `Flag.choice`/
// `Flag.choiceWithValue` — plus the schema-backed `integer`, `float`,
// `boolean`, and `date`) fail with a raw message that already starts with
// the word "Expected" (e.g. `Expected "micro" | "small", got "nano"` or
// `Expected a valid date, got Invalid Date`), and `CliError.InvalidValue`'s
// own `message` getter independently prepends its own `"Expected: "` label
// on top of that — so any flag or argument backed by one of these
// primitives renders "Expected: Expected ...". Detect this from
// `error.expected` (the field the buggy primitives actually populate)
// rather than searching the fully composed `error.message`: `error.value`
// is user-controlled and interpolated into that same message (including a
// second time inside `expected` itself, via `choice`'s "got <value>"
// suffix), so a message-wide, first-occurrence string replace can target
// the wrong spot if the value itself happens to contain the literal text
// "Expected: Expected ". Anchoring on `error.expected` and rebuilding the
// message from the same template `CliError.InvalidValue` uses avoids ever
// scanning `error.value`. Remove once upstream `effect` fixes this (see
// CLI-1898).
//
// TODO: remove once Effect-TS/effect#6312 is fixed upstream.
// https://github.com/Effect-TS/effect/issues/6312
//
// Shared by two call sites that each see `InvalidValue` failures at a
// different point in `effect`'s CLI runtime:
// - `subcommand-flag-suggestions.ts` formats errors that reach the
//   `CliOutput.Formatter` via the `ShowHelp` envelope — i.e. ordinary
//   subcommand/argument flags, validated while `Command.runWith` parses the
//   command tree.
// - `normalize-error.ts` formats errors from `GlobalFlag.setting` flags
//   (`--output-format`, and the legacy `--output`/`-o`, `--dns-resolver`,
//   `--agent`), which `Command.runWith` validates in a later step that runs
//   *outside* the `ShowHelp` path and therefore never reaches the
//   formatter — it surfaces as a raw failure through `runCli`'s catch-all
//   instead.
const EXPECTED_PREFIX = "Expected ";

export interface InvalidValueMessageFields {
  readonly option: string;
  readonly value: string;
  readonly expected: string;
  readonly kind: "flag" | "argument";
}

/**
 * Rebuilds a `CliError.InvalidValue` message from its own template when
 * `expected` carries the doubled "Expected" prefix. Returns `undefined` when
 * `expected` is unaffected, so callers can fall back to the error's own
 * untouched `message`.
 */
export function formatInvalidValueMessage(error: InvalidValueMessageFields): string | undefined {
  if (!error.expected.startsWith(EXPECTED_PREFIX)) return undefined;
  return error.kind === "argument"
    ? `Invalid value for argument <${error.option}>: "${error.value}". ${error.expected}`
    : `Invalid value for flag --${error.option}: "${error.value}". ${error.expected}`;
}
