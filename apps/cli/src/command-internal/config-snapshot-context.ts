import type { CliConfig } from "@supabase/config";
import { ENV_CAPTURE_REGEX, resolveCliConfigSubtree } from "@supabase/config/internal";
import { Effect, Option, Path, Redacted } from "effect";

import { lookupCliConfigEnv } from "../config/cli-config-key.ts";
import { CliConfigKeys } from "../config/cli-config-keys.ts";
import { CliConfigValues } from "../config/cli-config-values.service.ts";
import type { CliConfigSnapshot } from "../config/cli-config-values.service.ts";
import { loadCliProjectEnvFiles, readShellEnvironment } from "../shared/config/cli-config-env.ts";
import { CliConfigLoadError } from "../shared/config/cli-config.errors.ts";
import { sanitizeProjectId } from "./docker-ids.ts";
import { getHostname } from "./hostname.ts";

/** The decoded config with every override applied, plus the document and env views its readers need. */
interface ConfigSnapshotContext {
  readonly snapshot: CliConfigSnapshot;
  readonly config: CliConfig;
  /** Values that came from `supabase/.env*` files only; a name the shell sets is never in here. */
  readonly projectEnvValues: Record<string, string>;
  /** The merged `config.toml` sections with `env()` references resolved; `undefined` when absent. */
  readonly document: Record<string, unknown> | undefined;
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

/** The non-empty env values `env(NAME)` references in `trees` resolve to, shell before project `.env*`. */
export const snapshotEnvValues = (
  snapshot: CliConfigSnapshot,
  ...trees: ReadonlyArray<unknown>
): Record<string, string> => {
  const names = new Set<string>();
  collectEnvNames(trees, names);
  const values: Record<string, string> = {};
  for (const name of names) {
    const value = lookupCliConfigEnv(snapshot.sources, name);
    if (value !== undefined) values[name] = value;
  }
  return values;
};

const revealSecrets = (value: unknown): unknown => {
  if (Redacted.isRedacted(value)) return Redacted.value(value);
  if (Array.isArray(value)) return value.map(revealSecrets);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, revealSecrets(item)]),
    );
  }
  return value;
};

const resolvedDocument = (snapshot: CliConfigSnapshot) =>
  Effect.gen(function* () {
    const sections = Object.keys(snapshot.materialized.config).flatMap((name) => {
      const section = snapshot.sources.context.configAt(name);
      return name === "remotes" || section === undefined ? [] : [[name, section] as const];
    });
    if (sections.length === 0) return undefined;
    const values = snapshotEnvValues(snapshot, sections);
    const resolved: Record<string, unknown> = {};
    for (const [name, section] of sections) {
      resolved[name] = revealSecrets(
        yield* resolveCliConfigSubtree(section, { values }, name, { goViperCompat: true }),
      );
    }
    return resolved;
  });

/** Loads the snapshot for a command that targets no project, so no `[remotes.*]` block applies. */
export const loadConfigSnapshotContext = Effect.fn("ConfigSnapshotContext.load")(function* (
  workdir: string,
  projectRef: Option.Option<string> = Option.none(),
) {
  const values = yield* CliConfigValues;
  const snapshot = yield* values.load({ workdir, projectRef });
  const shell = yield* readShellEnvironment();
  const projectEnv = yield* loadCliProjectEnvFiles(workdir, { shell });
  return {
    snapshot,
    config: snapshot.materialized.config,
    projectEnvValues: { ...projectEnv.values },
    document: yield* resolvedDocument(snapshot),
  } satisfies ConfigSnapshotContext;
});

/** A {@link ConfigSnapshotContext} plus the machine hostname and sanitized project id local Docker naming needs. */
export interface LocalSnapshotContext extends ConfigSnapshotContext {
  readonly hostname: string;
  readonly projectId: string;
}

export const loadLocalSnapshotContext = Effect.fn("LocalSnapshotContext.load")(function* (
  workdir: string,
  projectRef: Option.Option<string> = Option.none(),
) {
  const context = yield* loadConfigSnapshotContext(workdir, projectRef);
  const hostname = yield* getHostname().pipe(
    Effect.mapError(
      (cause) =>
        new CliConfigLoadError({ message: `failed to resolve hostname: ${cause.message}` }),
    ),
  );
  const path = yield* Path.Path;
  const projectId = sanitizeProjectId(context.config.project_id ?? path.basename(workdir));
  return { ...context, hostname, projectId } satisfies LocalSnapshotContext;
});

/** `auth.passkey` and `auth.webauthn` exist only when their tables do; an env override never creates one. */
export const resolveSnapshotPasskeyWebauthn = Effect.fn("ConfigSnapshotContext.passkeyWebauthn")(
  function* (snapshot: CliConfigSnapshot) {
    const { configAt } = snapshot.sources.context;
    const passkeyEnabled =
      configAt("auth.passkey") === undefined
        ? undefined
        : (yield* snapshot.get(CliConfigKeys.auth.passkey.enabled)).value;
    const webauthn =
      configAt("auth.webauthn") === undefined
        ? undefined
        : {
            rpId: (yield* snapshot.get(CliConfigKeys.auth.webauthn.rpId)).value,
            rpDisplayName: (yield* snapshot.get(CliConfigKeys.auth.webauthn.rpDisplayName)).value,
            rpOrigins: (yield* snapshot.get(CliConfigKeys.auth.webauthn.rpOrigins)).value,
          };
    return { passkeyEnabled, webauthn };
  },
);

/** The failure text commands report when the config snapshot cannot be loaded. */
export const describeConfigSnapshotFailure = (cause: unknown): string =>
  typeof cause === "object" &&
  cause !== null &&
  "_tag" in cause &&
  (cause._tag === "CliConfigValueError" || cause._tag === "CliConfigLoadError") &&
  "message" in cause &&
  typeof cause.message === "string"
    ? cause.message
    : `failed to read config: ${String(cause)}`;
