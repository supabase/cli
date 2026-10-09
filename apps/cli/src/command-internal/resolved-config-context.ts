import type { CliConfig } from "@supabase/config";
import { Effect, Option } from "effect";

import { CliConfigKeys } from "../config/cli-config-keys.ts";
import { CliConfigValues } from "../config/cli-config-values.service.ts";
import type { ResolvedCliConfig } from "../config/cli-config-values.service.ts";
import { CliConfigLoadError } from "../shared/config/cli-config-load.errors.ts";
import { getHostname } from "./hostname.ts";

/** The resolved config with the materialized config, project env values and declared document its readers take. */
interface ResolvedConfigContext {
  readonly resolvedConfig: ResolvedCliConfig;
  readonly config: CliConfig;
  readonly projectEnvValues: Readonly<Record<string, string>>;
  readonly document: Record<string, unknown> | undefined;
}

/** Loads the resolved config for a command that targets no project, so no `[remotes.*]` block applies. */
export const loadResolvedConfigContext = Effect.fn("ResolvedConfigContext.load")(function* (
  workdir: string,
  projectRef: Option.Option<string> = Option.none(),
) {
  const values = yield* CliConfigValues;
  const resolvedConfig = yield* values.load({ workdir, projectRef });
  return {
    resolvedConfig,
    config: resolvedConfig.materialized.config,
    projectEnvValues: resolvedConfig.projectEnvValues,
    document: resolvedConfig.loaded.document,
  } satisfies ResolvedConfigContext;
});

/** A {@link ResolvedConfigContext} plus the machine hostname and sanitized project id local Docker naming needs. */
export interface LocalResolvedConfigContext extends ResolvedConfigContext {
  readonly hostname: string;
  readonly projectId: string;
}

export const loadLocalResolvedConfigContext = Effect.fn("LocalResolvedConfigContext.load")(
  function* (workdir: string, projectRef: Option.Option<string> = Option.none()) {
    const context = yield* loadResolvedConfigContext(workdir, projectRef);
    const hostname = yield* getHostname().pipe(
      Effect.mapError(
        (cause) =>
          new CliConfigLoadError({ message: `failed to resolve hostname: ${cause.message}` }),
      ),
    );
    const projectId = (yield* context.resolvedConfig.get(CliConfigKeys.projectId)).value;
    return { ...context, hostname, projectId } satisfies LocalResolvedConfigContext;
  },
);

/** `auth.passkey` and `auth.webauthn` exist only when their tables do; an env override never creates one. */
export const resolvePasskeyWebauthn = Effect.fn("ResolvedConfigContext.passkeyWebauthn")(function* (
  resolvedConfig: ResolvedCliConfig,
) {
  const passkeyEnabled = resolvedConfig.declares("auth.passkey")
    ? (yield* resolvedConfig.get(CliConfigKeys.auth.passkey.enabled)).value
    : undefined;
  const webauthn = resolvedConfig.declares("auth.webauthn")
    ? {
        rpId: (yield* resolvedConfig.get(CliConfigKeys.auth.webauthn.rpId)).value,
        rpDisplayName: (yield* resolvedConfig.get(CliConfigKeys.auth.webauthn.rpDisplayName)).value,
        rpOrigins: (yield* resolvedConfig.get(CliConfigKeys.auth.webauthn.rpOrigins)).value,
      }
    : undefined;
  return { passkeyEnabled, webauthn };
});

/** The failure text commands report when the resolved config cannot be loaded. */
export const describeConfigLoadFailure = (cause: unknown): string =>
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
