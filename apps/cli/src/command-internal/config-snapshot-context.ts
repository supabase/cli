import type { CliConfig } from "@supabase/config";
import { Effect, Option } from "effect";

import { CliConfigKeys } from "../config/cli-config-keys.ts";
import { CliConfigValues } from "../config/cli-config-values.service.ts";
import type { CliConfigSnapshot } from "../config/cli-config-values.service.ts";
import { CliConfigLoadError } from "../shared/config/cli-config-load.errors.ts";
import { getHostname } from "./hostname.ts";

/** The snapshot with the materialized config, project env values and declared document its readers take. */
interface ConfigSnapshotContext {
  readonly snapshot: CliConfigSnapshot;
  readonly config: CliConfig;
  readonly projectEnvValues: Readonly<Record<string, string>>;
  readonly document: Record<string, unknown> | undefined;
}

/** Loads the snapshot for a command that targets no project, so no `[remotes.*]` block applies. */
export const loadConfigSnapshotContext = Effect.fn("ConfigSnapshotContext.load")(function* (
  workdir: string,
  projectRef: Option.Option<string> = Option.none(),
) {
  const values = yield* CliConfigValues;
  const snapshot = yield* values.load({ workdir, projectRef });
  return {
    snapshot,
    config: snapshot.materialized.config,
    projectEnvValues: snapshot.projectEnvValues,
    document: snapshot.loaded.document,
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
    const passkeyEnabled = snapshot.declares("auth.passkey")
      ? (yield* snapshot.get(CliConfigKeys.auth.passkey.enabled)).value
      : undefined;
    const webauthn = snapshot.declares("auth.webauthn")
      ? {
          rpId: (yield* snapshot.get(CliConfigKeys.auth.webauthn.rpId)).value,
          rpDisplayName: (yield* snapshot.get(CliConfigKeys.auth.webauthn.rpDisplayName)).value,
          rpOrigins: (yield* snapshot.get(CliConfigKeys.auth.webauthn.rpOrigins)).value,
        }
      : undefined;
    return { passkeyEnabled, webauthn };
  },
);

/** The failure text commands report when the config snapshot cannot be loaded. */
export const describeConfigSnapshotFailure = (cause: unknown): string =>
  typeof cause === "object" &&
  cause !== null &&
  "_tag" in cause &&
  (cause._tag === "CliConfigValueError" ||
    cause._tag === "CliConfigFlagConflictError" ||
    cause._tag === "CliConfigLoadError") &&
  "message" in cause &&
  typeof cause.message === "string"
    ? cause.message
    : `failed to read config: ${String(cause)}`;
