import { CliConfigParseError, findCliProjectRoot } from "@supabase/config/effect";
import { Effect, Option } from "effect";

import { isDocumentRecord } from "../../config/cli-config-document.ts";
import { cliRemoteProjectIdEnvName } from "../../config/cli-config-keys.ts";
import { selectCliConfigRemote } from "../../config/cli-config-remote.ts";
import { CliConfigValues } from "../../config/cli-config-values.service.ts";
import type { ResolvedCliConfig } from "../../config/cli-config-values.service.ts";
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
 * Loads the resolved config for the `config` family: the `[remotes.*]` block matched to
 * `projectRef`, the env overlay and the `env()` values every command resolves. A missing file
 * suggests `supabase init` only for a defaulted workdir.
 */
export const loadResolvedConfig = Effect.fnUntraced(function* <E>(
  cliSettings: ConfigWorkdir,
  projectRoot: string,
  projectRef: Option.Option<string>,
  makeError: (message: string) => E,
) {
  const values = yield* CliConfigValues;
  const resolvedConfig = yield* values
    .load({ workdir: projectRoot, projectRef, tolerateUnreadableLinkedRef: true })
    .pipe(mapConfigLoadError(cliSettings, makeError));
  if (!resolvedConfig.hasConfigFile) {
    return yield* Effect.fail(makeError(yield* missingProjectConfigMessageEffect(cliSettings)));
  }
  yield* Effect.annotateCurrentSpan(
    "config.remote_applied",
    Option.isSome(resolvedConfig.appliedRemote),
  );
  return resolvedConfig;
});

/**
 * The resolved config for the resolved target. A command loads once before it knows the target, to fail
 * on a missing or invalid config before any network call; that resolved config stands unless a
 * `[remotes.*]` block selects `ref`, since loading again prints its warnings twice.
 */
export const loadTargetResolvedConfig = Effect.fnUntraced(function* <E>(
  cliSettings: ConfigWorkdir,
  projectRoot: string,
  early: ResolvedCliConfig,
  ref: string,
  makeError: (message: string) => E,
) {
  const remotes = early.loaded.rawDocument?.["remotes"];
  if (!isDocumentRecord(remotes)) return early;
  const overrides = yield* early.envValues(Object.keys(remotes).map(cliRemoteProjectIdEnvName));
  const selected = selectCliConfigRemote(remotes, Option.some(ref), (name) => overrides[name]);
  return selected === undefined
    ? early
    : yield* loadResolvedConfig(cliSettings, projectRoot, Option.some(ref), makeError);
});

/** What the config file itself declares; `config pull` compares against it because it rewrites the file. */
export const loadDeclaredFileConfig = Effect.fnUntraced(function* <E>(
  cliSettings: ConfigWorkdir,
  projectRoot: string,
  projectRef: Option.Option<string>,
  makeError: (message: string) => E,
) {
  const resolvedConfig = yield* loadResolvedConfig(cliSettings, projectRoot, projectRef, makeError);
  const loaded = yield* resolvedConfig.fileDeclared.pipe(
    mapConfigLoadError(cliSettings, makeError),
  );
  return { resolvedConfig, loaded };
});
