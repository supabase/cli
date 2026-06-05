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
