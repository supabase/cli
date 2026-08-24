import { Data, Effect, FileSystem, Option, Path, Result } from "effect";

import { CliArgs } from "../../shared/cli/cli-args.service.ts";
import {
  lastExplicitLongFlagValue,
  type PflagArgvScan,
} from "../../shared/cli/cobra-flag-groups.ts";
import { LegacyProfileFlag, LegacyWorkdirFlag } from "../../shared/legacy/global-flags.ts";
import { RuntimeInfo } from "../../shared/runtime/runtime-info.service.ts";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../shared/telemetry/error-actionability.ts";
import { legacyProfileFilePath } from "../config/legacy-profile-file.ts";
import { LegacyViperEnv } from "../../shared/legacy/legacy-viper-env.ts";
import { legacyLoadProfile, type LegacyLoadedProfile } from "./legacy-profile-load.ts";
import { legacyParseStringSliceFlag } from "./legacy-string-slice-flag.ts";
import { legacyValidateWorkdirIsDirectory } from "./legacy-workdir-validation.ts";

/**
 * Hoisted here ahead of a second command family landing on purpose: a human
 * reviewer flagged in #5974 that the pflag-vs-Effect-parser divergence this
 * module reconciles is CLI-wide, not sso-specific, and asked for it to live
 * in a shared layer rather than be reimplemented per command family —
 * https://github.com/supabase/cli/pull/5974#discussion_r3685149895 (CLI-1982).
 */

/**
 * `ChangeWorkDir`, run from the root
 * `PersistentPreRunE` — after `ParseFlags` and
 * `ValidateArgs`, before `ValidateRequiredFlags`, `ValidateFlagGroups`, and
 * `RunE` — so a missing workdir directory aborts with no API call ever made.
 * Emulated for the pflag/viper-effective `--workdir`/`SUPABASE_WORKDIR` the
 * Effect layer never validates (and, when `--workdir` consumed a flag-shaped
 * token, never even saw — PR #5974 review round 6). Shared across add +
 * update; message byte-matches Go's template.
 *
 * Flows through {@link legacyValidatePflagWorkdir}'s inferred Effect error
 * channel; no call site imports the class by name.
 *
 * @public
 */
export class LegacyPflagWorkdirError extends Data.TaggedError("LegacyPflagWorkdirError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

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
export function legacyPflagStringValue(
  occurrences: ReadonlyMap<string, ReadonlyArray<string>>,
  flagName: string,
): Option.Option<string> {
  const values = occurrences.get(flagName);
  return values === undefined ? Option.none() : Option.some(values[values.length - 1] ?? "");
}

/**
 * Like `legacyPflagStringValue`, but for pflag `StringSliceVar` flags:
 * every occurrence is CSV-split and accumulated, matching pflag's
 * `stringSliceValue.Set`. An absent flag reconciles to `[]` even when the
 * Effect parser produced values (its tokens were consumed by another flag).
 *
 * `parsedFallback` is only returned if the scan's raw values are malformed
 * CSV — unreachable through the real CLI, because the Effect parser sees the
 * same raw values and rejects the command at parse time before the handler
 * runs; the fallback just keeps a handler-level disagreement from crashing.
 */
export function legacyPflagSliceValue(
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
 * The workdir `ChangeWorkDir` would
 * `os.Chdir` to: `viper.GetString("WORKDIR")` resolves the pflag-effective
 * `--workdir` first (a changed flag wins even when its value is empty —
 * `--workdir=` falls through to the always-existing project-root walk-up,
 * never to the env var) and `SUPABASE_WORKDIR` otherwise. `Option.none`
 * means Go would chdir to the walk-up default, which cannot fail.
 *
 * Resolution order (binary-verified, PR #5974 review
 * round 6):
 * - the scan's last `--workdir` occurrence wins — pflag consumes flag-shaped
 * tokens the Effect parser refuses (`--workdir --metadata-file` binds
 * `"--metadata-file"`), so the parsed flag cannot be trusted;
 * - when the `--workdir` token itself was consumed as another flag's value
 * (`--domains --workdir`), pflag never marks it changed and viper falls to
 * the env var — the parsed flag (which read the following token as a
 * normal value) must be ignored;
 * - otherwise the Effect-parsed value covers what the anchored scan cannot
 * see: `--workdir` placed before the command path (`supabase --workdir x
 * sso add …`), which cobra's `Find`/`stripFlags` routes to the same
 * persistent flag.
 */
export function legacyPflagWorkdirValue(
  scan: Pick<PflagArgvScan, "occurrences" | "consumedFlagNames" | "prePathOccurrences">,
  parsedWorkdir: Option.Option<string>,
  envWorkdir: string | undefined,
): Option.Option<string> {
  const scanned = legacyPflagStringValue(scan.occurrences, "workdir");
  // Same last-wins order as the profile resolver: post-path occurrence →
  // pre-path occurrence (pflag parses persistent flags before the command
  // path and repeats resolve last-wins, while the Effect parser is
  // first-wins) → consumed-discard → parsed fallback (review r3690…, the
  // pre-path workdir twin of r3686720491).
  const prePathValues = scan.prePathOccurrences.get("workdir");
  const prePath =
    prePathValues !== undefined && prePathValues.length > 0
      ? Option.some(prePathValues[prePathValues.length - 1] as string)
      : Option.none<string>();
  const flagValue = Option.isSome(scanned)
    ? scanned
    : Option.isSome(prePath)
      ? prePath
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
 * Emulates `ChangeWorkDir` for the workdir {@link legacyPflagWorkdirValue}
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
export const legacyValidatePflagWorkdir = Effect.fnUntraced(function* (
  scan: Pick<PflagArgvScan, "occurrences" | "consumedFlagNames" | "prePathOccurrences">,
) {
  // `serviceOption`: absent outside the real CLI tree (handler-level tests
  // provide argv via `Stdio.layerTest`, not the global flag settings).
  const parsedWorkdir = Option.flatten(yield* Effect.serviceOption(LegacyWorkdirFlag));
  const env = yield* LegacyViperEnv;
  const envWorkdir = yield* env
    .get("SUPABASE_WORKDIR")
    .pipe(Effect.orElseSucceed(() => Option.none<string>()));
  const workdir = legacyPflagWorkdirValue(scan, parsedWorkdir, Option.getOrUndefined(envWorkdir));
  if (Option.isNone(workdir)) {
    return;
  }
  const fs = yield* FileSystem.FileSystem;
  yield* legacyValidateWorkdirIsDirectory(workdir.value, fs).pipe(
    Effect.mapError((cause) => new LegacyPflagWorkdirError({ message: cause.message })),
  );
});

/**
 * The explicit (flag-or-env) profile token viper's `GetString("PROFILE")` /
 * `IsSet("PROFILE")` would resolve (`getProfileName`).
 * `Option.none` means it would fall through to the persisted
 * `~/.supabase/profile` file and then the `supabase` default.
 *
 * Resolution order mirrors {@link legacyPflagWorkdirValue} (same viper
 * semantics, binary-verified for `--profile` in PR #5974 review round 7):
 * - the scan's last `--profile` occurrence wins — pflag consumes flag-shaped
 * tokens the Effect parser refuses (`--profile --metadata-url` binds
 * `"--metadata-url"`), is last-wins where the parser is first-wins, and a
 * scanned occurrence marks the flag changed even when its value is the
 * `supabase` default or empty;
 * - when the `--profile` token itself was consumed as another flag's value
 * (`--domains --profile alternate.yml`), pflag never marks it changed and
 * viper falls to `SUPABASE_PROFILE` — the parsed flag (which read the
 * following token as a normal value) must be ignored;
 * - otherwise the Effect-parsed value covers pre-command-path placement
 * (`supabase --profile x sso add …`) the anchored scan cannot see. The
 * parsed flag cannot distinguish an explicit `--profile supabase` from the
 * flag's default, so that value is treated as unset (the config layer
 * closes the same gap with its own argv scan,
 * `legacy-cli-config.layer.ts`).
 */
export function legacyPflagProfileValue(
  scan: Pick<PflagArgvScan, "occurrences" | "consumedFlagNames" | "prePathOccurrences">,
  parsedProfile: Option.Option<string>,
  envProfile: string | undefined,
): Option.Option<string> {
  const scanned = legacyPflagStringValue(scan.occurrences, "profile");
  // pflag's effective value is the LAST parsed occurrence anywhere in argv:
  // a post-path occurrence wins outright; otherwise a persistent pre-path
  // occurrence (`--profile A sso add …`) stays effective even when a later
  // profile-shaped token was CONSUMED as another flag's value — discarding
  // it here fell through to env/file/default and targeted a host Go never
  // contacts (review r3686720491).
  const prePathValues = scan.prePathOccurrences.get("profile");
  const prePath =
    prePathValues !== undefined && prePathValues.length > 0
      ? Option.some(prePathValues[prePathValues.length - 1] as string)
      : Option.none<string>();
  const flagValue = Option.isSome(scanned)
    ? scanned
    : Option.isSome(prePath)
      ? prePath
      : scan.consumedFlagNames.has("profile")
        ? Option.none<string>()
        : Option.filter(parsedProfile, (value) => value !== "supabase");
  if (Option.isSome(flagValue)) {
    return flagValue;
  }
  return envProfile !== undefined && envProfile.length > 0
    ? Option.some(envProfile)
    : Option.none();
}

/**
 * Emulates `LoadProfile` for
 * the pflag/viper-effective profile, returning the API URL the request must
 * target when it differs from the one the Effect config layer resolved —
 * `Option.none` means the layer's `LegacyCliConfig.apiUrl` already matches
 * the established resolution. The profile loads immediately BEFORE `ChangeWorkDir`, so a load
 * failure here must precede the workdir check (and, like it, the
 * required-flag check, the mutex check, and any API request).
 *
 * The emulation only takes over when the viper-effective token disagrees
 * with the token the config layer resolved from the parsed flag — i.e.
 * exactly where the Effect parser and pflag diverge (consumed tokens,
 * flag-shaped values, repeat resolution, explicit `--profile supabase`
 * shadowing the env, an untrimmed persisted-file token) — or when the token
 * is empty, which Go deterministically rejects. Where the two agree (every
 * normal invocation), the layer's resolution stands unchanged — it uses the
 * same strict `legacyLoadProfile` and explicit-flag detection
 * (supabase/cli#6091). Argv shapes where pflag's token consumption diverges
 * from the Effect parser can still fail the layer build before this
 * reconcile runs; those fail-closed on both sides, possibly with different
 * detail text.
 *
 * `serviceOption` throughout: outside the real CLI tree (handler-level tests
 * provide argv via `Stdio.layerTest`) the flag settings and `RuntimeInfo`
 * may be absent; the emulation then only acts on what the scan itself shows.
 */
export const legacyResolvePflagProfile = Effect.fnUntraced(function* (
  scan: Pick<PflagArgvScan, "occurrences" | "consumedFlagNames" | "prePathOccurrences">,
) {
  const parsedRaw = yield* Effect.serviceOption(LegacyProfileFlag);
  const parsedProfile = Option.filter(parsedRaw, (value) => value !== "supabase");
  const envService = yield* LegacyViperEnv;
  const envHome = yield* envService
    .get("SUPABASE_HOME")
    .pipe(Effect.orElseSucceed(() => Option.none<string>()));
  const envValue = yield* envService
    .get("SUPABASE_PROFILE")
    .pipe(Effect.orElseSucceed(() => Option.none<string>()));
  const envProfile = Option.match(envValue, {
    onNone: () => undefined,
    onSome: (value) => (value.length > 0 ? value : undefined),
  });

  // viper-effective explicit token vs the config layer's explicit token.
  // The layer-model MUST mirror `resolveProfile` exactly (raw argv scan →
  // parsed flag ≠ default → env): the layer's scan treats the last raw
  // `--profile` occurrence as explicit even when pflag consumed it as another
  // flag's value, so omitting it here would make the comparison miss a layer
  // that shadowed the env and silently target the wrong host. When both agree
  // on a non-empty explicit token, the layer resolved the exact same profile
  // the Go binary would target.
  const scanExplicit = Option.match(yield* Effect.serviceOption(CliArgs), {
    onNone: () => undefined,
    onSome: ({ args }) => lastExplicitLongFlagValue(args, [], "profile"),
  });
  const goExplicit = legacyPflagProfileValue(scan, parsedProfile, envProfile);
  const layerExplicit =
    scanExplicit !== undefined
      ? Option.some(scanExplicit)
      : Option.isSome(parsedProfile)
        ? parsedProfile
        : envProfile !== undefined
          ? Option.some(envProfile)
          : Option.none<string>();
  if (
    Option.isSome(goExplicit) &&
    Option.isSome(layerExplicit) &&
    goExplicit.value === layerExplicit.value &&
    goExplicit.value !== ""
  ) {
    return Option.none<LegacyLoadedProfile>();
  }

  const fs = yield* Effect.serviceOption(FileSystem.FileSystem);
  const path = yield* Effect.serviceOption(Path.Path);
  const runtimeInfo = yield* Effect.serviceOption(RuntimeInfo);
  if (Option.isNone(fs) || Option.isNone(path) || Option.isNone(runtimeInfo)) {
    return Option.none<LegacyLoadedProfile>();
  }

  // Lowest precedence: the persisted `~/.supabase/profile` file. The reference
  // resolution uses the
  // raw bytes (`string(content)`); the config layer
  // trims and maps empty to the default — a real divergence the token
  // comparison below surfaces (e.g. a trailing newline fails with
  // `Unsupported Config Type ""`, binary-verified).
  const fileRaw = yield* fs.value
    .readFileString(
      legacyProfileFilePath(path.value, runtimeInfo.value.homeDir, Option.getOrUndefined(envHome)),
    )
    .pipe(Effect.option);

  const goToken = Option.isSome(goExplicit)
    ? goExplicit.value
    : Option.isSome(fileRaw)
      ? fileRaw.value
      : "supabase";
  const layerToken = Option.isSome(layerExplicit)
    ? layerExplicit.value
    : Option.match(fileRaw, {
        onNone: () => "supabase",
        onSome: (content) => {
          const trimmed = content.trim();
          return trimmed.length === 0 ? "supabase" : trimmed;
        },
      });

  if (goToken === layerToken && goToken !== "") {
    return Option.none<LegacyLoadedProfile>();
  }
  return Option.some(yield* legacyLoadProfile(goToken, fs.value));
});

/** Go's `strconv.ParseBool` accepted literals. */
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
 * Like `legacyPflagStringValue`, but for pflag `BoolVar` flags. pflag
 * calls `Value.Set` for every occurrence in argv order: a bare occurrence
 * sets `NoOptDefVal` (`"true"`), an inline `=value` goes through
 * `strconv.ParseBool`, an invalid literal aborts `ParseFlags` with
 * `invalid argument …` before `ValidateArgs`,
 * every hook, and `RunE` — the failure branch here must therefore win over
 * every later handler check. The last occurrence wins; an absent flag is
 * `false` (the default).
 *
 * This cannot be read off the Effect-parsed boolean for two reasons
 * (binary-verified, PR #5974 review round 4):
 * - the Effect parser resolves repeated flags first-wins while pflag is
 * last-wins (`--skip-url-validation=false --skip-url-validation` is `true`
 * to Go, `false` to the parser), and
 * - the Effect parser accepts `yes`/`no`, which `strconv.ParseBool` rejects.
 *
 * The scan records a *bare* occurrence as pflag's `NoOptDefVal` `"true"`
 * and an inline-empty `--flag=` as `""`, so the
 * two stay distinguishable here: `""` goes through the ParseBool table and
 * fails the same way. Reachable despite the Effect parser rejecting an
 * explicit empty boolean at parse time, because first-wins parsing never
 * validates later occurrences (binary-verified, PR #5974 review round 5:
 * `--skip-url-validation=false --skip-url-validation=` aborts
 * ParseFlags before any request; the parser accepts the argv).
 */
export function legacyPflagBoolValue(
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
 * Like `legacyPflagStringValue`, but for enum-valued flags
 * (`ssoProviderType`, `ssoNameIDFormat`), whose
 * `Value.Set` rejects anything outside the allowed set. pflag Sets every
 * occurrence in argv order and aborts `ParseFlags` on the first invalid one —
 * reachable here because the Effect parser resolves repeats first-wins and
 * never validates later occurrences (`--type saml --type bogus` parses).
 * The last occurrence wins; an absent flag is `Option.none`.
 *
 * `flagLabel` is how pflag names the flag in the error: `--name` without a
 * shorthand, `-s, --name` with one.
 */
export function legacyPflagEnumValue(
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
