import {
  CliConfigParseError,
  findCliProjectRoot,
  type LoadedCliConfig,
} from "@supabase/config/effect";
import {
  decodeMergedCliConfig,
  mergeParsedCliConfig,
  type ParsedCliConfigDocument,
} from "@supabase/config/internal";
import { Effect, Option } from "effect";

import { envReferenceNames, isDocumentRecord } from "../../config/cli-config-document.ts";
import { cliRemoteProjectIdEnvName } from "../../config/cli-config-keys.ts";
import { selectCliConfigRemote } from "../../config/cli-config-remote.ts";
import { CliConfigValues } from "../../config/cli-config-values.service.ts";
import type { CliConfigSnapshot } from "../../config/cli-config-values.service.ts";
import {
  missingProjectConfigMessageEffect,
  relativeConfigPath,
} from "../../command-internal/workdir-project.ts";
import { shouldSearchAncestors } from "../../command-internal/workdir-search.ts";

export { relativeConfigPath };

interface ConfigWorkdir {
  readonly workdir: string;
  readonly explicitWorkdir: boolean;
}

/** The directory holding `supabase/`; only a defaulted workdir climbs to an ancestor's project. */
export const resolveConfigProjectRoot = Effect.fnUntraced(function* (cliSettings: ConfigWorkdir) {
  const root = yield* findCliProjectRoot(cliSettings.workdir, {
    search: shouldSearchAncestors(cliSettings),
  });
  return root ?? cliSettings.workdir;
});

const describeLoadFailure = (
  cliSettings: ConfigWorkdir,
  cause: { readonly message: string },
): string =>
  cause instanceof CliConfigParseError
    ? `failed to parse ${relativeConfigPath(cliSettings.workdir, cause.path)}: ${String(cause.cause)}`
    : cause.message;

/**
 * Maps a config load failure onto the command's own load error. A parse failure names the file
 * that actually failed, since `config.json` is probed before `config.toml`. An invalid value keeps
 * its `CliConfigValueError`, which already names the source that supplied it.
 */
export const mapConfigLoadError =
  <E>(cliSettings: ConfigWorkdir, makeError: (message: string) => E) =>
  <A, F extends { readonly _tag: string; readonly message: string }, R>(
    effect: Effect.Effect<A, F, R>,
  ) =>
    Effect.catchIf(
      effect,
      (cause): cause is Exclude<F, { readonly _tag: "CliConfigValueError" }> =>
        cause._tag !== "CliConfigValueError",
      (cause) => Effect.fail(makeError(describeLoadFailure(cliSettings, cause))),
    );

/**
 * Loads the config snapshot for the `config` family: the `[remotes.*]` block matched to
 * `projectRef`, the env overlay and the `env()` values every command resolves. A missing file
 * suggests `supabase init` only for a defaulted workdir.
 */
export const loadConfigSnapshot = Effect.fnUntraced(function* <E>(
  cliSettings: ConfigWorkdir,
  projectRoot: string,
  projectRef: Option.Option<string>,
  makeError: (message: string) => E,
) {
  const values = yield* CliConfigValues;
  const snapshot = yield* values
    .load({ workdir: projectRoot, projectRef, tolerateUnreadableLinkedRef: true })
    .pipe(mapConfigLoadError(cliSettings, makeError));
  if (!snapshot.hasConfigFile) {
    return yield* Effect.fail(makeError(yield* missingProjectConfigMessageEffect(cliSettings)));
  }
  yield* Effect.annotateCurrentSpan("config.remote_applied", Option.isSome(snapshot.appliedRemote));
  return snapshot;
});

/**
 * The snapshot for the resolved target. A command loads once before it knows the target, to fail
 * on a missing or invalid config before any network call; that snapshot stands unless a
 * `[remotes.*]` block selects `ref`, since loading again prints its warnings twice.
 */
export const loadTargetConfigSnapshot = Effect.fnUntraced(function* <E>(
  cliSettings: ConfigWorkdir,
  projectRoot: string,
  early: CliConfigSnapshot,
  ref: string,
  makeError: (message: string) => E,
) {
  const remotes = early.loaded.rawDocument?.["remotes"];
  if (!isDocumentRecord(remotes)) return early;
  const overrides = yield* early.envValues(Object.keys(remotes).map(cliRemoteProjectIdEnvName));
  const selected = selectCliConfigRemote(remotes, Option.some(ref), (name) => overrides[name]);
  return selected === undefined
    ? early
    : yield* loadConfigSnapshot(cliSettings, projectRoot, Option.some(ref), makeError);
});

/**
 * `snapshot.loaded` with the `env()` reference behind each value kept as an `environment` origin;
 * the loaded view resolves a numeric or boolean reference to a literal, which would hide the
 * variable from a diff row.
 */
export function declaredConfigWithEnvOrigins(snapshot: CliConfigSnapshot): LoadedCliConfig {
  const referenced = [...snapshot.origins.values()].flatMap((origin) =>
    origin.tier === "config" && origin.origin.source === "environment" ? [origin.origin] : [],
  );
  if (referenced.length === 0) return snapshot.loaded;
  const paths = new Set(referenced.map((origin) => origin.path.join(".")));
  return {
    ...snapshot.loaded,
    valueOrigins: [
      ...(snapshot.loaded.valueOrigins ?? []).filter((origin) => !paths.has(origin.path.join("."))),
      ...referenced,
    ],
  };
}

/**
 * What the config file itself declares: the snapshot's `[remotes.*]` block merged over the base
 * and `env()` references resolved through the snapshot, with no flag or `SUPABASE_*` overlay.
 * `config pull` compares against this view because it rewrites the file.
 */
export const loadDeclaredFileConfig = Effect.fnUntraced(function* <E>(
  cliSettings: ConfigWorkdir,
  projectRoot: string,
  projectRef: Option.Option<string>,
  makeError: (message: string) => E,
) {
  const snapshot = yield* loadConfigSnapshot(cliSettings, projectRoot, projectRef, makeError);
  const { loaded: overlaid } = snapshot;
  const parsed: ParsedCliConfigDocument = {
    path: overlaid.path,
    format: overlaid.format,
    rawText: overlaid.rawText ?? "",
    schemaRef: overlaid.schemaRef,
    ignoredPaths: overlaid.ignoredPaths,
    rawDocument: overlaid.rawDocument,
    normalized: overlaid.rawDocument,
  };
  const mapped = mapConfigLoadError(cliSettings, makeError);
  const merged = yield* mergeParsedCliConfig(parsed, {
    selectRemote: (remotes) => {
      const applied = Option.getOrUndefined(snapshot.appliedRemote);
      return applied !== undefined && applied in remotes ? applied : undefined;
    },
  }).pipe(mapped);
  const envValues = yield* snapshot.envValues(envReferenceNames(merged.rawDocument));
  const loaded = yield* decodeMergedCliConfig(merged, {
    envValues,
    goViperCompat: true,
    silent: true,
  }).pipe(mapped);
  return { snapshot, loaded };
});
