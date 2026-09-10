import { Data, Effect, FileSystem, Option, Path, Result } from "effect";

import { CliArgs } from "../shared/cli/cli-args.service.ts";
import { lastExplicitLongFlagValue, type PflagArgvScan } from "../shared/cli/cobra-flag-groups.ts";
import { ProfileFlag, WorkdirFlag } from "./global-flags.ts";
import { RuntimeInfo } from "../shared/runtime/runtime-info.service.ts";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../shared/telemetry/error-actionability.ts";
import { profileFilePath } from "../config/profile-file.ts";
import { loadProfile, type LoadedProfile } from "./profile-load.ts";
import { parseStringSliceFlag } from "./string-slice-flag.ts";
import { validateWorkdirIsDirectory } from "./workdir-validation.ts";

/**
 * A missing or non-directory `--workdir`/`SUPABASE_WORKDIR`, checked before any other flag
 * validation or API call — the Effect CLI parser never validates this path itself, and can
 * miss the value entirely when `--workdir` consumed a flag-shaped token.
 *
 * Flows through {@link validatePflagWorkdir}'s inferred Effect error channel; no call site
 * imports the class by name.
 */
export class PflagWorkdirError extends Data.TaggedError("PflagWorkdirError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/**
 * Reconciles an Effect-parsed option flag with pflag's raw-argv semantics: the flag is only
 * set when the raw scan says pflag would have set it, using the scan's own value (last
 * occurrence wins for a `StringVar`).
 *
 * The vendored Effect parser refuses to consume a flag-shaped token as a value, while pflag
 * consumes it unconditionally — in `--project-ref --metadata-file x.xml --metadata-url u`,
 * pflag hands `--metadata-file` to `--project-ref` and never sets `metadata-file`, so acting
 * on the parsed options there would still read the metadata file unexpectedly. The two agree
 * on every normal invocation.
 */
export function pflagStringValue(
  occurrences: ReadonlyMap<string, ReadonlyArray<string>>,
  flagName: string,
): Option.Option<string> {
  const values = occurrences.get(flagName);
  return values === undefined ? Option.none() : Option.some(values[values.length - 1] ?? "");
}

/**
 * Like `pflagStringValue`, but for CSV-accumulating slice flags: every occurrence is
 * CSV-split and accumulated. An absent flag reconciles to `[]` even when the Effect parser
 * produced values (its tokens were consumed by another flag).
 *
 * `parsedFallback` only returns when the scan's raw values are malformed CSV — unreachable in
 * practice, since the Effect parser rejects the same malformed input at parse time before the
 * handler runs; it just keeps a handler-level disagreement from crashing.
 */
export function pflagSliceValue(
  occurrences: ReadonlyMap<string, ReadonlyArray<string>>,
  flagName: string,
  parsedFallback: ReadonlyArray<string>,
): ReadonlyArray<string> {
  const values = occurrences.get(flagName);
  if (values === undefined) {
    return [];
  }
  try {
    return parseStringSliceFlag(values);
  } catch {
    return parsedFallback;
  }
}

/**
 * The workdir a changed `--workdir`/`SUPABASE_WORKDIR` resolves to: a changed `--workdir`
 * wins even when its value is empty (`--workdir=` falls through to the project-root walk-up,
 * never to the env var), otherwise `SUPABASE_WORKDIR`. `Option.none` means the walk-up
 * default applies, which cannot fail.
 *
 * Resolution order:
 * - the scan's last `--workdir` occurrence wins — pflag consumes flag-shaped tokens the
 *   Effect parser refuses (`--workdir --metadata-file` binds `"--metadata-file"`), so the
 *   parsed flag cannot be trusted;
 * - when the `--workdir` token itself was consumed as another flag's value
 *   (`--domains --workdir`), the parsed flag (which read the following token as a normal
 *   value) is ignored in favor of the env var;
 * - otherwise the Effect-parsed value covers what the anchored scan cannot see: `--workdir`
 *   placed before the command path (`supabase --workdir x sso add …`).
 */
export function pflagWorkdirValue(
  scan: Pick<PflagArgvScan, "occurrences" | "consumedFlagNames" | "prePathOccurrences">,
  parsedWorkdir: Option.Option<string>,
  envWorkdir: string | undefined,
): Option.Option<string> {
  const scanned = pflagStringValue(scan.occurrences, "workdir");
  // Same last-wins order as the profile resolver: post-path occurrence, then pre-path
  // occurrence, then consumed-discard, then the parsed fallback.
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
 * Validates the workdir {@link pflagWorkdirValue} resolves, aborting before any API call when
 * it's missing or not a directory — the config layer only path-resolves the workdir it sees
 * and never validates this, and can miss the value entirely when `--workdir` consumed a
 * flag-shaped token.
 *
 * Accepted divergence: when the resolved directory exists, this check and the config layer
 * may have resolved the workdir from different sources, but they then issue the identical
 * request regardless.
 */
export const validatePflagWorkdir = Effect.fnUntraced(function* (
  scan: Pick<PflagArgvScan, "occurrences" | "consumedFlagNames" | "prePathOccurrences">,
) {
  // `serviceOption`: absent outside the real CLI tree (handler-level tests
  // provide argv via `Stdio.layerTest`, not the global flag settings).
  const parsedWorkdir = Option.flatten(yield* Effect.serviceOption(WorkdirFlag));
  const workdir = pflagWorkdirValue(scan, parsedWorkdir, process.env["SUPABASE_WORKDIR"]);
  if (Option.isNone(workdir)) {
    return;
  }
  const fs = yield* FileSystem.FileSystem;
  yield* validateWorkdirIsDirectory(workdir.value, fs).pipe(
    Effect.mapError((cause) => new PflagWorkdirError({ message: cause.message })),
  );
});

/**
 * The explicit (flag-or-env) profile token this command would resolve. `Option.none` means
 * it falls through to the persisted `~/.supabase/profile` file and then the `supabase`
 * default.
 *
 * Resolution order mirrors {@link pflagWorkdirValue}:
 * - the scan's last `--profile` occurrence wins — pflag consumes flag-shaped tokens the
 *   Effect parser refuses (`--profile --metadata-url` binds `"--metadata-url"`), and a
 *   scanned occurrence marks the flag changed even when its value is the `supabase` default
 *   or empty;
 * - when the `--profile` token itself was consumed as another flag's value
 *   (`--domains --profile alternate.yml`), the parsed flag (which read the following token
 *   as a normal value) is ignored in favor of `SUPABASE_PROFILE`;
 * - otherwise the Effect-parsed value covers pre-command-path placement
 *   (`supabase --profile x sso add …`) the anchored scan cannot see. The parsed flag can't
 *   distinguish an explicit `--profile supabase` from the flag's default, so that value is
 *   treated as unset.
 */
export function pflagProfileValue(
  scan: Pick<PflagArgvScan, "occurrences" | "consumedFlagNames" | "prePathOccurrences">,
  parsedProfile: Option.Option<string>,
  envProfile: string | undefined,
): Option.Option<string> {
  const scanned = pflagStringValue(scan.occurrences, "profile");
  // A post-path occurrence wins outright; otherwise a pre-path occurrence
  // (`--profile A sso add …`) stays effective even when a later profile-shaped token was
  // consumed as another flag's value.
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
 * Reconciles the profile the Effect config layer resolved with the {@link pflagProfileValue}
 * semantics, returning the API URL a request must target when they disagree — `Option.none`
 * means the layer's `CommandSettings.apiUrl` already matches. Loads before the workdir check
 * and any other flag validation or API request, since it can change which host every
 * subsequent request targets.
 *
 * Only takes over where the two resolutions genuinely diverge (consumed tokens, flag-shaped
 * values, repeat resolution, an explicit `--profile supabase` shadowing the env, an untrimmed
 * persisted-file token) or when the resolved token is empty. On every normal invocation the
 * layer's resolution stands unchanged.
 *
 * `serviceOption` throughout: outside the real CLI tree (handler-level tests provide argv via
 * `Stdio.layerTest`) the flag settings and `RuntimeInfo` may be absent, and the reconcile then
 * only acts on what the scan itself shows.
 */
export const resolvePflagProfile = Effect.fnUntraced(function* (
  scan: Pick<PflagArgvScan, "occurrences" | "consumedFlagNames" | "prePathOccurrences">,
) {
  const parsedRaw = yield* Effect.serviceOption(ProfileFlag);
  const parsedProfile = Option.filter(parsedRaw, (value) => value !== "supabase");
  const env = process.env["SUPABASE_PROFILE"];
  const envProfile = env !== undefined && env.length > 0 ? env : undefined;

  // The explicit token pflag-equivalent semantics resolve, vs. the one the config layer's own
  // scan resolved (which treats the last raw `--profile` occurrence as explicit even when it
  // was consumed as another flag's value). When both agree on a non-empty token, the layer
  // already resolved the right profile.
  const scanExplicit = Option.match(yield* Effect.serviceOption(CliArgs), {
    onNone: () => undefined,
    onSome: ({ args }) => lastExplicitLongFlagValue(args, [], "profile"),
  });
  const goExplicit = pflagProfileValue(scan, parsedProfile, envProfile);
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
    return Option.none<LoadedProfile>();
  }

  const fs = yield* Effect.serviceOption(FileSystem.FileSystem);
  const path = yield* Effect.serviceOption(Path.Path);
  const runtimeInfo = yield* Effect.serviceOption(RuntimeInfo);
  if (Option.isNone(fs) || Option.isNone(path) || Option.isNone(runtimeInfo)) {
    return Option.none<LoadedProfile>();
  }

  // Lowest precedence: the persisted `~/.supabase/profile` file. This reads the raw bytes,
  // while the config layer trims and maps empty to the default — a divergence the token
  // comparison below surfaces (e.g. a trailing newline fails to load as a profile).
  const fileRaw = yield* fs.value
    .readFileString(profileFilePath(path.value, runtimeInfo.value.homeDir))
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
    return Option.none<LoadedProfile>();
  }
  return Option.some(yield* loadProfile(goToken, fs.value));
});

/** Accepted literal spellings for a pflag boolean flag value (`strconv.ParseBool`). */
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
 * Like `pflagStringValue`, but for boolean flags: every occurrence is applied in argv order
 * (a bare occurrence sets `true`; `--flag=value` is checked against the literal set above),
 * so the last occurrence wins and an absent flag is `false`. An occurrence with an
 * unrecognized literal fails immediately, before any other flag validation or API call.
 *
 * This can't be read off the Effect-parsed boolean: the Effect parser resolves repeated
 * flags first-wins (pflag is last-wins) and accepts `yes`/`no`, which the literal set above
 * rejects. The scan records a bare occurrence as `"true"` and an inline-empty `--flag=` as
 * `""`, so both go through the same literal-set check and fail consistently.
 */
export function pflagBoolValue(
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
 * Like `pflagStringValue`, but for enum-valued flags: every occurrence must be in `allowed`,
 * checked in argv order, and the first invalid one fails immediately — reachable here because
 * the Effect parser resolves repeats first-wins and never validates later occurrences (e.g.
 * `--type saml --type bogus` parses). The last occurrence wins; an absent flag is
 * `Option.none`.
 *
 * `flagLabel` names the flag in the error message: `--name` without a shorthand, `-s, --name`
 * with one.
 */
export function pflagEnumValue(
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
