import { Effect, FileSystem, Option, Result } from "effect";

import type { PflagArgvScan } from "../../../shared/cli/cobra-flag-groups.ts";
import { LegacyWorkdirFlag } from "../../../shared/legacy/global-flags.ts";
import { legacyParseStringSliceFlag } from "../../shared/legacy-string-slice-flag.ts";
import { legacyValidateWorkdirIsDirectory } from "../../shared/legacy-workdir-validation.ts";
import { LegacySsoWorkdirError } from "./sso.errors.ts";

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

/**
 * The workdir Go's `ChangeWorkDir` (`internal/utils/misc.go:238-257`) would
 * `os.Chdir` to: `viper.GetString("WORKDIR")` resolves the pflag-effective
 * `--workdir` first (a changed flag wins even when its value is empty —
 * `--workdir=` falls through to the always-existing project-root walk-up,
 * never to the env var) and `SUPABASE_WORKDIR` otherwise. `Option.none`
 * means Go would chdir to the walk-up default, which cannot fail.
 *
 * Resolution order (binary-verified against `apps/cli-go`, PR #5974 review
 * round 6):
 * - the scan's last `--workdir` occurrence wins — pflag consumes flag-shaped
 *   tokens the Effect parser refuses (`--workdir --metadata-file` binds
 *   `"--metadata-file"`), so the parsed flag cannot be trusted;
 * - when the `--workdir` token itself was consumed as another flag's value
 *   (`--domains --workdir`), pflag never marks it changed and viper falls to
 *   the env var — the parsed flag (which read the following token as a
 *   normal value) must be ignored;
 * - otherwise the Effect-parsed value covers what the anchored scan cannot
 *   see: `--workdir` placed before the command path (`supabase --workdir x
 *   sso add …`), which cobra's `Find`/`stripFlags` routes to the same
 *   persistent flag.
 */
export function legacySsoPflagWorkdirValue(
  scan: Pick<PflagArgvScan, "occurrences" | "consumedFlagNames">,
  parsedWorkdir: Option.Option<string>,
  envWorkdir: string | undefined,
): Option.Option<string> {
  const scanned = legacySsoPflagStringValue(scan.occurrences, "workdir");
  const flagValue = Option.isSome(scanned)
    ? scanned
    : scan.consumedFlagNames.has("workdir")
      ? Option.none<string>()
      : parsedWorkdir;
  if (Option.isSome(flagValue)) {
    return flagValue.value.length > 0 ? flagValue : Option.none();
  }
  return envWorkdir !== undefined && envWorkdir.length > 0
    ? Option.some(envWorkdir)
    : Option.none();
}

/**
 * Emulates Go's `ChangeWorkDir` (`cmd/root.go:104`, `internal/utils/
 * misc.go:238-257`) for the workdir {@link legacySsoPflagWorkdirValue}
 * resolves: `os.Chdir` on a missing path or a non-directory aborts the
 * command from the root `PersistentPreRunE` — after `ParseFlags` and
 * `ValidateArgs`, before `ValidateRequiredFlags`, `ValidateFlagGroups`, and
 * `RunE` — so no API call is ever made. The Effect layer neither validates
 * the resolved workdir (`legacy-cli-config.layer.ts` only path-resolves it)
 * nor sees the value at all when `--workdir` consumed a flag-shaped token,
 * hence the emulation here (PR #5974 review round 6).
 *
 * Accepted micro-divergence: when the pflag-bound workdir names a directory
 * that EXISTS, Go chdir's into it (printing `Using workdir …`) while the
 * config layer keeps the workdir it resolved from the parsed flag — both
 * sides then issue the identical request for these inputs.
 */
export const legacySsoValidatePflagWorkdir = Effect.fnUntraced(function* (
  scan: Pick<PflagArgvScan, "occurrences" | "consumedFlagNames">,
) {
  // `serviceOption`: absent outside the real CLI tree (handler-level tests
  // provide argv via `Stdio.layerTest`, not the global flag settings).
  const parsedWorkdir = Option.flatten(yield* Effect.serviceOption(LegacyWorkdirFlag));
  const workdir = legacySsoPflagWorkdirValue(scan, parsedWorkdir, process.env["SUPABASE_WORKDIR"]);
  if (Option.isNone(workdir)) {
    return;
  }
  const fs = yield* FileSystem.FileSystem;
  yield* legacyValidateWorkdirIsDirectory(workdir.value, fs).pipe(
    Effect.mapError((cause) => new LegacySsoWorkdirError({ message: cause.message })),
  );
});

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
 * The scan records a *bare* occurrence as pflag's `NoOptDefVal` `"true"`
 * (pflag `flag.go:1017-1019`) and an inline-empty `--flag=` as `""`, so the
 * two stay distinguishable here: `""` goes through the ParseBool table and
 * fails exactly like Go. Reachable despite the Effect parser rejecting an
 * explicit empty boolean at parse time, because first-wins parsing never
 * validates later occurrences (binary-verified, PR #5974 review round 5:
 * `--skip-url-validation=false --skip-url-validation=` aborts Go's
 * ParseFlags before any request; the parser accepts the argv).
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
