import { Option, Result } from "effect";

import { legacyParseStringSliceFlag } from "../../shared/legacy-string-slice-flag.ts";

/**
 * Reconciles an Effect-parsed option flag with pflag semantics
 * (`pflagArgvScan`): the flag is only set when the raw-argv scan
 * says pflag would have set it, and its value is the scan's — for a pflag
 * `StringVar`, the last occurrence wins.
 *
 * This matters because the vendored Effect parser refuses to consume a
 * flag-shaped token as a value while pflag consumes it unconditionally
 * (`run.unit.test.ts`, CLI-1982). In
 * `--project-ref --metadata-file x.xml --metadata-url u`, pflag hands
 * `--metadata-file` to `--project-ref` as its value and never sets
 * `metadata-file`; acting on the parsed options there would suppress the
 * mutex error yet still read the metadata file — an API call the Go CLI
 * never makes. When the scan and the parser agree (every normal invocation),
 * the scan's value is byte-identical to the parsed one.
 */
export function legacySsoPflagStringValue(
  occurrences: ReadonlyMap<string, ReadonlyArray<string>>,
  flagName: string,
): Option.Option<string> {
  const values = occurrences.get(flagName);
  return values === undefined ? Option.none() : Option.some(values[values.length - 1] ?? "");
}

/**
 * Like `legacySsoPflagStringValue`, but for pflag `StringSliceVar` flags:
 * every occurrence is CSV-split and accumulated, matching pflag's
 * `stringSliceValue.Set`. An absent flag reconciles to `[]` even when the
 * Effect parser produced values (its tokens were consumed by another flag).
 *
 * `parsedFallback` is only returned if the scan's raw values are malformed
 * CSV — unreachable through the real CLI, because the Effect parser sees the
 * same raw values and rejects the command at parse time before the handler
 * runs; the fallback just keeps a handler-level disagreement from crashing.
 */
export function legacySsoPflagSliceValue(
  occurrences: ReadonlyMap<string, ReadonlyArray<string>>,
  flagName: string,
  parsedFallback: ReadonlyArray<string>,
): ReadonlyArray<string> {
  const values = occurrences.get(flagName);
  if (values === undefined) {
    return [];
  }
  try {
    return legacyParseStringSliceFlag(values);
  } catch {
    return parsedFallback;
  }
}

/** Go's `strconv.ParseBool` accepted literals (`strconv/atob.go:10-19`). */
const GO_PARSE_BOOL: ReadonlyMap<string, boolean> = new Map([
  ["1", true],
  ["t", true],
  ["T", true],
  ["TRUE", true],
  ["true", true],
  ["True", true],
  ["0", false],
  ["f", false],
  ["F", false],
  ["FALSE", false],
  ["false", false],
  ["False", false],
]);

/**
 * Like `legacySsoPflagStringValue`, but for pflag `BoolVar` flags. pflag
 * calls `Value.Set` for every occurrence in argv order: a bare occurrence
 * sets `NoOptDefVal` (`"true"`), an inline `=value` goes through
 * `strconv.ParseBool`, an invalid literal aborts `ParseFlags` with
 * `invalid argument …` (pflag `errors.go:32-48`) before `ValidateArgs`,
 * every hook, and `RunE` — the failure branch here must therefore win over
 * every later handler check. The last occurrence wins; an absent flag is
 * `false` (the Go default).
 *
 * This cannot be read off the Effect-parsed boolean for two reasons
 * (binary-verified against `apps/cli-go`, PR #5974 review round 4):
 * - the Effect parser resolves repeated flags first-wins while pflag is
 *   last-wins (`--skip-url-validation=false --skip-url-validation` is `true`
 *   to Go, `false` to the parser), and
 * - the Effect parser accepts `yes`/`no`, which `strconv.ParseBool` rejects.
 *
 * A recorded empty value is a *bare* occurrence, not `--flag=`: the Effect
 * parser rejects an explicit empty boolean at parse time, so argv carrying
 * one never reaches a handler.
 */
export function legacySsoPflagBoolValue(
  occurrences: ReadonlyMap<string, ReadonlyArray<string>>,
  flagName: string,
): Result.Result<boolean, string> {
  const values = occurrences.get(flagName);
  if (values === undefined) {
    return Result.succeed(false);
  }
  let effective = false;
  for (const raw of values) {
    if (raw === "") {
      effective = true;
      continue;
    }
    const parsed = GO_PARSE_BOOL.get(raw);
    if (parsed === undefined) {
      return Result.fail(
        `invalid argument ${JSON.stringify(raw)} for "--${flagName}" flag: strconv.ParseBool: parsing ${JSON.stringify(raw)}: invalid syntax`,
      );
    }
    effective = parsed;
  }
  return Result.succeed(effective);
}

/**
 * Like `legacySsoPflagStringValue`, but for Go enum-valued flags
 * (`ssoProviderType`, `ssoNameIDFormat` — `cmd/sso.go:157-158,176`), whose
 * `Value.Set` rejects anything outside the allowed set. pflag Sets every
 * occurrence in argv order and aborts `ParseFlags` on the first invalid one
 * — reachable here because the Effect parser resolves repeats first-wins and
 * never validates later occurrences (`--type saml --type bogus` parses).
 * The last occurrence wins; an absent flag is `Option.none`.
 *
 * `flagLabel` is how pflag names the flag in the error: `--name` without a
 * shorthand, `-s, --name` with one (pflag `errors.go:39-41`).
 */
export function legacySsoPflagEnumValue(
  occurrences: ReadonlyMap<string, ReadonlyArray<string>>,
  flagName: string,
  allowed: ReadonlyArray<string>,
  flagLabel: string = `--${flagName}`,
): Result.Result<Option.Option<string>, string> {
  const values = occurrences.get(flagName);
  if (values === undefined) {
    return Result.succeed(Option.none());
  }
  for (const raw of values) {
    if (!allowed.includes(raw)) {
      return Result.fail(
        `invalid argument ${JSON.stringify(raw)} for "${flagLabel}" flag: must be one of [ ${allowed.join(" | ")} ]`,
      );
    }
  }
  return Result.succeed(Option.some(values[values.length - 1] ?? ""));
}
