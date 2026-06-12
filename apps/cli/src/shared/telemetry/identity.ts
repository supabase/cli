import { Effect, Option } from "effect";
import { readTelemetryConfig, writeTelemetryConfig } from "./consent.ts";
import type { TelemetryConfig } from "./types.ts";

const SESSION_TIMEOUT_MS = 30 * 60 * 1000;

export const resolveIdentity = Effect.fnUntraced(function* (configDir: string) {
  const config = yield* readTelemetryConfig(configDir);
  const now = Date.now();

  if (Option.isNone(config)) {
    const newConfig: TelemetryConfig = {
      consent: "granted",
      device_id: crypto.randomUUID(),
      session_id: crypto.randomUUID(),
      session_last_active: now,
    };
    yield* writeTelemetryConfig(newConfig, configDir);
    return {
      deviceId: newConfig.device_id,
      sessionId: newConfig.session_id,
      distinctId: undefined,
      isFirstRun: true,
    };
  }

  const currentConfig = config.value;
  const isSessionExpired = now - currentConfig.session_last_active > SESSION_TIMEOUT_MS;
  const sessionId = isSessionExpired ? crypto.randomUUID() : currentConfig.session_id;

  yield* writeTelemetryConfig(
    { ...currentConfig, session_id: sessionId, session_last_active: now },
    configDir,
  );
  return {
    deviceId: currentConfig.device_id,
    sessionId,
    distinctId: currentConfig.distinct_id,
    isFirstRun: false,
  };
});

export const saveDistinctId = Effect.fnUntraced(function* (configDir: string, distinctId: string) {
  const identity = yield* resolveIdentity(configDir);
  const config = yield* readTelemetryConfig(configDir);
  const nextConfig: TelemetryConfig = {
    consent: Option.match(config, {
      onNone: () => "granted",
      onSome: (value) => value.consent,
    }),
    device_id: identity.deviceId,
    session_id: identity.sessionId,
    session_last_active: Date.now(),
    distinct_id: distinctId,
  };
  yield* writeTelemetryConfig(nextConfig, configDir);
});

/**
 * True when `~/.supabase/` will not survive this invocation (CI runners,
 * Docker, `npx supabase`), detected heuristically. Identity stitching
 * ($create_alias + persisted distinct_id) is wasted in these environments;
 * only in-memory stamping applies.
 * See docs/adr/0013-hybrid-stitch-stamp-identity-attribution.md.
 */
export function isEphemeralIdentityRuntime(runtime: {
  readonly isCi: boolean;
  readonly isFirstRun: boolean;
  readonly isTty: boolean;
}): boolean {
  return runtime.isCi || (runtime.isFirstRun && !runtime.isTty);
}

/**
 * In-process identity for telemetry capture events: the persisted distinct_id
 * snapshot at startup, overridden when the process learns the authenticated
 * user ("stamping"), emptied on logout. The single source of truth consulted
 * at capture time — see docs/adr/0013-hybrid-stitch-stamp-identity-attribution.md.
 */
export interface TelemetryIdentity {
  readonly current: () => string | undefined;
  readonly stamp: (distinctId: string) => void;
  readonly clear: () => void;
}

export function makeTelemetryIdentity(persisted: string | undefined): TelemetryIdentity {
  let value = persisted;
  return {
    current: () => value,
    stamp: (distinctId: string) => {
      value = distinctId;
    },
    clear: () => {
      value = undefined;
    },
  };
}

/**
 * Logout-only: forget the user AND rotate the device id, severing the link
 * between this device and the logged-out user's person graph. A later login
 * as a different account then aliases a fresh device. Transient failure
 * paths use clearDistinctId, which keeps the device id.
 */
export const resetIdentity = Effect.fnUntraced(function* (configDir: string) {
  const identity = yield* resolveIdentity(configDir);
  const config = yield* readTelemetryConfig(configDir);
  const nextConfig: TelemetryConfig = {
    consent: Option.match(config, {
      onNone: () => "granted",
      onSome: (value) => value.consent,
    }),
    device_id: crypto.randomUUID(),
    session_id: identity.sessionId,
    session_last_active: Date.now(),
  };
  yield* writeTelemetryConfig(nextConfig, configDir);
});

export const clearDistinctId = Effect.fnUntraced(function* (configDir: string) {
  const identity = yield* resolveIdentity(configDir);
  const config = yield* readTelemetryConfig(configDir);
  const nextConfig: TelemetryConfig = {
    consent: Option.match(config, {
      onNone: () => "granted",
      onSome: (value) => value.consent,
    }),
    device_id: identity.deviceId,
    session_id: identity.sessionId,
    session_last_active: Date.now(),
  };
  yield* writeTelemetryConfig(nextConfig, configDir);
});
