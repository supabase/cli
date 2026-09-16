// Some of effect's own CLI primitive parsers (`choice`, and the schema-backed `integer`, `float`,
// `boolean`, `date`) fail with an `expected` string that already starts with "Expected", which
// `CliError.InvalidValue`'s own message getter then prefixes again, rendering
// "Expected: Expected ...". Anchors on `error.expected` rather than the composed `message`, since
// `error.value` is user-controlled and can itself contain that literal text.
//
// TODO(CLI-1898): remove once https://github.com/Effect-TS/effect/issues/6312 is fixed upstream.
const EXPECTED_PREFIX = "Expected ";

// Some flags already fail with pflag's own byte-exact diagnostic (e.g. malformed CSV in a
// string-slice flag), which the CLI's stderr contract must reproduce verbatim. Wrapping it in
// `CliError.InvalidValue`'s own template would double-frame it, so render it as-is instead.
const PFLAG_INVALID_ARGUMENT_PREFIX = "invalid argument ";

export interface InvalidValueMessageFields {
  readonly option: string;
  readonly value: string;
  readonly expected: string;
  readonly kind: "flag" | "argument";
}

/**
 * Rebuilds a `CliError.InvalidValue` message from its own template when `expected` carries the
 * doubled "Expected" prefix, or passes `expected` through verbatim when it's already a complete
 * pflag-format diagnostic. Returns `undefined` when unaffected, so callers fall back to the
 * error's own message.
 */
export function formatInvalidValueMessage(error: InvalidValueMessageFields): string | undefined {
  if (error.expected.startsWith(PFLAG_INVALID_ARGUMENT_PREFIX)) return error.expected;
  if (!error.expected.startsWith(EXPECTED_PREFIX)) return undefined;
  return error.kind === "argument"
    ? `Invalid value for argument <${error.option}>: "${error.value}". ${error.expected}`
    : `Invalid value for flag --${error.option}: "${error.value}". ${error.expected}`;
}
