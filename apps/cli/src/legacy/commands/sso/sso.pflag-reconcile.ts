import { Option } from "effect";

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
