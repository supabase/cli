import type { CliConfig } from "@supabase/config";
import { ENV_CAPTURE_REGEX, resolveCliConfigSubtree } from "@supabase/config/internal";
import { Effect, Option, Redacted, Result } from "effect";

import { setDocumentValue } from "../config/cli-config-document.ts";
import { lookupCliConfigEnv, pickCliConfigKey } from "../config/cli-config-key.ts";
import {
  CliConfigKeys,
  cliConfigFamilyKey,
  cliConfigRegistry,
  type AnyCliConfigKey,
} from "../config/cli-config-keys.ts";
import { CliConfigValues } from "../config/cli-config-values.service.ts";
import type { CliConfigSnapshot } from "../config/cli-config-values.service.ts";
import { loadCliProjectEnvFiles, readShellEnvironment } from "../shared/config/cli-config-env.ts";
import { CliConfigLoadError } from "../shared/config/cli-config.errors.ts";
import { getHostname } from "./hostname.ts";

/** The decoded config with every override applied, plus the document and env views its readers need. */
interface ConfigSnapshotContext {
  readonly snapshot: CliConfigSnapshot;
  readonly config: CliConfig;
  /** Values that came from `supabase/.env*` files only; a name the shell sets is never in here. */
  readonly projectEnvValues: Record<string, string>;
  /** The merged `config.toml` sections with every winner written in; `undefined` when there are none. */
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
const effectiveDocument = (snapshot: CliConfigSnapshot) =>
  Effect.gen(function* () {
    const sections = Object.keys(snapshot.materialized.config).flatMap((name) => {
      const section = snapshot.sources.context.configAt(name);
      return name === "remotes" || section === undefined ? [] : [[name, section] as const];
    });
    const values = snapshotEnvValues(snapshot, sections);
    const document: Record<string, unknown> = {};
    for (const [name, section] of sections) {
      document[name] = revealSecrets(
        yield* resolveCliConfigSubtree(section, { values }, name, { goViperCompat: true }),
      );
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
    return Object.keys(document).length === 0 ? undefined : document;
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
    document: yield* effectiveDocument(snapshot),
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
  const projectId = (yield* context.snapshot.get(CliConfigKeys.projectId)).value;
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
