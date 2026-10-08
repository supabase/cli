import type { CliConfig } from "@supabase/config";
import type { LoadedCliConfig } from "@supabase/config/effect";
import { ENV_CAPTURE_REGEX, resolveCliConfigSubtree } from "@supabase/config/internal";
import { Crypto, Effect, FileSystem, Option, Path, Result } from "effect";

import {
  cliConfigFamilyKey,
  cliConfigRegistry,
  type AnyCliConfigKey,
} from "../config/cli-config-keys.ts";
import { lookupCliConfigEnv, pickCliConfigKey } from "../config/cli-config-key.ts";
import { setDocumentValue } from "../config/cli-config-document.ts";
import { CliConfigValues, type CliConfigSnapshot } from "../config/cli-config-values.service.ts";
import { loadCliProjectEnvFiles, readShellEnvironment } from "../shared/config/cli-config-env.ts";
import { RuntimeInfo } from "../shared/runtime/runtime-info.service.ts";
import { recordOrioleDbTelemetry } from "./db-image.ts";
import { sanitizeProjectId } from "./docker-ids.ts";
import { getHostname } from "./hostname.ts";

/** The parts of a loaded config that readers still take: the effective config and document. */
interface LocalLoadedConfig extends Pick<LoadedCliConfig, "config" | "appliedRemote"> {
  readonly document: Record<string, unknown>;
}

/** Effective config, project env file values, hostname, and sanitized project id for a command. */
export interface LocalProjectContext {
  /** The decoded config with every override applied. */
  readonly config: CliConfig;
  /** Values from `supabase/.env*` files only; a name the shell sets is never in here. */
  readonly projectEnvValues: Record<string, string>;
  readonly loaded: LocalLoadedConfig;
  readonly snapshot: CliConfigSnapshot;
  readonly hostname: string;
  /** Sanitized project id; see {@link sanitizeProjectId}. */
  readonly projectId: string;
}

const collectEnvNames = (value: unknown, out: Set<string>): void => {
  if (typeof value === "string") {
    const name = ENV_CAPTURE_REGEX.exec(value)?.[1];
    if (name !== undefined) out.add(name);
  } else if (Array.isArray(value)) {
    for (const item of value) collectEnvNames(item, out);
  } else if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) collectEnvNames(item, out);
  }
};

const documentKeys = (snapshot: CliConfigSnapshot): ReadonlyArray<AnyCliConfigKey> => [
  ...cliConfigRegistry.keys.filter((key) => key.document !== false),
  ...cliConfigRegistry.families.flatMap((family) =>
    snapshot
      .familyNames(family.id)
      .flatMap((name) =>
        family.fields.flatMap((field) => cliConfigFamilyKey(family, name, field.name) ?? []),
      ),
  ),
];

/**
 * The merged config sections with `env()` references resolved and every flag, environment and
 * decrypted-secret winner written in, so presence checks and unmodeled fields read what the
 * snapshot resolved. Defaults are not written, which keeps absent sections absent.
 */
const effectiveConfigDocument = Effect.fn("LocalProjectContext.effectiveDocument")(function* (
  snapshot: CliConfigSnapshot,
) {
  const sections = Object.keys(snapshot.materialized.config).flatMap((name) => {
    const section = snapshot.sources.context.configAt(name);
    return name === "remotes" || section === undefined ? [] : [[name, section] as const];
  });
  const names = new Set<string>();
  collectEnvNames(sections, names);
  const values: Record<string, string> = {};
  for (const name of names) {
    const value = lookupCliConfigEnv(snapshot.sources, name);
    if (value !== undefined) values[name] = value;
  }
  const document: Record<string, unknown> = {};
  for (const [name, section] of sections) {
    document[name] = yield* resolveCliConfigSubtree(section, { values }, name, {
      goViperCompat: true,
    });
  }
  for (const key of documentKeys(snapshot)) {
    const picked = pickCliConfigKey(key, snapshot.sources);
    if (Result.isFailure(picked)) return yield* picked.failure;
    const { value, origin } = picked.success;
    const winsDocument =
      origin.tier === "flag" ||
      origin.tier === "shell" ||
      origin.tier === "projectEnv" ||
      (origin.tier === "config" && key.secret === true);
    if (!winsDocument) continue;
    const written = key.toDocument(value);
    if (written !== undefined) setDocumentValue(document, key.path, written);
  }
  return document;
});

/** The failure text commands report when the snapshot cannot be loaded. */
const describeSnapshotFailure = (cause: unknown): string =>
  typeof cause === "object" &&
  cause !== null &&
  "_tag" in cause &&
  (cause._tag === "CliConfigValueError" || cause._tag === "CliConfigLoadError") &&
  "message" in cause &&
  typeof cause.message === "string"
    ? cause.message
    : `failed to read config: ${String(cause)}`;

export const loadLocalProjectContext = <E>(
  workdir: string,
  mapConfigLoadError: (message: string) => E,
  // An already-resolved `--linked`/`--project-ref` value, when the caller has one; it selects
  // the matching `[remotes.<ref>]` block. `undefined` applies no remote.
  projectRef?: string,
): Effect.Effect<
  LocalProjectContext,
  E,
  FileSystem.FileSystem | Path.Path | RuntimeInfo | Crypto.Crypto | CliConfigValues
> =>
  Effect.gen(function* () {
    const values = yield* CliConfigValues;
    const mapFailure = (cause: unknown) => mapConfigLoadError(describeSnapshotFailure(cause));

    const snapshot = yield* values
      .load({ workdir, projectRef: Option.fromNullishOr(projectRef) })
      .pipe(Effect.mapError(mapFailure));
    const shell = yield* readShellEnvironment().pipe(Effect.mapError(mapFailure));
    const projectEnv = yield* loadCliProjectEnvFiles(workdir, { shell }).pipe(
      Effect.mapError(mapFailure),
    );
    const document = yield* effectiveConfigDocument(snapshot).pipe(Effect.mapError(mapFailure));
    const hostname = yield* getHostname().pipe(
      Effect.mapError((cause) =>
        mapConfigLoadError(`failed to resolve hostname: ${cause.message}`),
      ),
    );
    const config = snapshot.materialized.config;
    const path = yield* Path.Path;
    const projectId = sanitizeProjectId(config.project_id ?? path.basename(workdir));
    const appliedRemote = Option.getOrUndefined(snapshot.appliedRemote);

    yield* Effect.annotateCurrentSpan({
      "config.remote_applied": appliedRemote !== undefined,
    });
    return {
      config,
      projectEnvValues: { ...projectEnv.values },
      loaded: { config, document, appliedRemote },
      snapshot,
      hostname,
      projectId,
    };
  }).pipe(Effect.withSpan("LocalProjectContext.load"));

/** Records OrioleDB selection for commands whose only local config read is this context. */
export const recordLocalProjectOrioleDbTelemetry = (context: LocalProjectContext) =>
  recordOrioleDbTelemetry(context.config.db.orioledb_version, context.config.db.major_version).pipe(
    Effect.ignore,
  );
