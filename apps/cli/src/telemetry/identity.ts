import { Effect } from "effect";
import { readTelemetryConfig, writeTelemetryConfig } from "./consent.ts";
import type { TelemetryConfig } from "./types.ts";

const SESSION_TIMEOUT_MS = 30 * 60 * 1000;

export const resolveIdentity = Effect.fnUntraced(function* (configDir: string) {
  const config = yield* readTelemetryConfig(configDir);
  const now = Date.now();

  if (!config) {
    const newConfig: TelemetryConfig = {
      consent: "granted",
      device_id: crypto.randomUUID(),
      session_id: crypto.randomUUID(),
      session_last_active: now,
    };
    yield* writeTelemetryConfig(newConfig, configDir);
    return { deviceId: newConfig.device_id, sessionId: newConfig.session_id, isFirstRun: true };
  }

  const isSessionExpired = now - config.session_last_active > SESSION_TIMEOUT_MS;
  const sessionId = isSessionExpired ? crypto.randomUUID() : config.session_id;

  yield* writeTelemetryConfig(
    { ...config, session_id: sessionId, session_last_active: now },
    configDir,
  );
  return { deviceId: config.device_id, sessionId, isFirstRun: false };
});
