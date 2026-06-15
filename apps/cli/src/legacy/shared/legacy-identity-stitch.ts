import { Context, Effect, FileSystem, Layer, Option, Path } from "effect";
import type * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import { Analytics } from "../../shared/telemetry/analytics.service.ts";
import { TelemetryRuntime } from "../../shared/telemetry/runtime.service.ts";

/**
 * Session identity stitching, a 1:1 port of Go's `identityTransport` +
 * `StitchLogin` (`apps/cli-go/internal/utils/identity_transport.go`,
 * `cmd/root.go:146-154`, `internal/telemetry/service.go:132-155`).
 *
 * In Go the transport wraps EVERY Management API response, so the first response
 * of a session that carries `X-Gotrue-Id` aliases the device id to the gotrue id
 * and persists `distinct_id` to `telemetry.json`. Both the typed
 * `LegacyPlatformApi` client and the raw-HTTP advisor path must run this, or a
 * command whose first API call is `db advisors --linked` silently skips it.
 */

const HEADER_GOTRUE_ID = "x-gotrue-id";
const TELEMETRY_SCHEMA_VERSION = 1;

interface LegacyTelemetryState {
  readonly enabled: boolean;
  readonly device_id: string;
  readonly session_id: string;
  readonly session_last_active: string;
  readonly distinct_id: string;
  readonly schema_version: number;
}

function gotrueIdFromResponse(response: HttpClientResponse.HttpClientResponse): string | undefined {
  const value = response.headers[HEADER_GOTRUE_ID] ?? response.headers["X-Gotrue-Id"];
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function fieldValue(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  return Reflect.get(value, key);
}

function stringField(value: unknown, key: string): string | undefined {
  const field = fieldValue(value, key);
  return typeof field === "string" && field.length > 0 ? field : undefined;
}

function boolField(value: unknown, key: string): boolean | undefined {
  const field = fieldValue(value, key);
  return typeof field === "boolean" ? field : undefined;
}

function numberField(value: unknown, key: string): number | undefined {
  const field = fieldValue(value, key);
  return typeof field === "number" && Number.isFinite(field) ? field : undefined;
}

function isEphemeralIdentityRuntime(runtime: {
  readonly isCi: boolean;
  readonly isFirstRun: boolean;
  readonly isTty: boolean;
}) {
  return runtime.isCi || (runtime.isFirstRun && !runtime.isTty);
}

/**
 * Builds a once-per-session stitcher. The returned function inspects a Management
 * API response's `X-Gotrue-Id` header and, when the session still needs stitching,
 * aliases + persists `distinct_id` at most once. Never fails (telemetry is
 * best-effort, matching the typed client's `Effect.exit` swallow).
 */
export const makeLegacyIdentityStitcher: Effect.Effect<
  (response: HttpClientResponse.HttpClientResponse) => Effect.Effect<void>,
  never,
  Analytics | TelemetryRuntime | FileSystem.FileSystem | Path.Path
> = Effect.gen(function* () {
  const analytics = yield* Analytics;
  const runtime = yield* TelemetryRuntime;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  let stitchAttempted = false;

  const needsIdentityStitch =
    runtime.consent === "granted" &&
    !isEphemeralIdentityRuntime(runtime) &&
    (runtime.distinctId === undefined || runtime.distinctId.length === 0);

  const stitchIdentity = (gotrueId: string) =>
    Effect.gen(function* () {
      if (!needsIdentityStitch || stitchAttempted) return;

      const telemetryPath = path.join(runtime.configDir, "telemetry.json");
      const existing = yield* fs.readFileString(telemetryPath).pipe(Effect.option);
      const prior = Option.match(existing, {
        onNone: () => undefined,
        onSome: (content) => {
          try {
            const parsed: unknown = JSON.parse(content);
            return parsed;
          } catch {
            return undefined;
          }
        },
      });
      const enabled = boolField(prior, "enabled") ?? true;
      if (!enabled) return;

      stitchAttempted = true;

      yield* analytics.alias(gotrueId, runtime.deviceId);

      const state: LegacyTelemetryState = {
        enabled,
        device_id: stringField(prior, "device_id") ?? runtime.deviceId,
        session_id: stringField(prior, "session_id") ?? runtime.sessionId,
        session_last_active: new Date().toISOString(),
        distinct_id: gotrueId,
        schema_version: numberField(prior, "schema_version") ?? TELEMETRY_SCHEMA_VERSION,
      };

      yield* fs.makeDirectory(runtime.configDir, { recursive: true });
      yield* fs.writeFileString(telemetryPath, JSON.stringify(state));
    });

  return (response: HttpClientResponse.HttpClientResponse) => {
    const gotrueId = gotrueIdFromResponse(response);
    if (gotrueId === undefined) return Effect.void;
    return stitchIdentity(gotrueId).pipe(Effect.exit, Effect.asVoid);
  };
});

interface LegacyIdentityStitchShape {
  /** Stitch the session identity from a Management API response, at most once. */
  readonly stitch: (response: HttpClientResponse.HttpClientResponse) => Effect.Effect<void>;
}

/**
 * Service wrapper over {@link makeLegacyIdentityStitcher} for the raw-HTTP advisor
 * path, which builds its own `HttpClient` rather than the typed `LegacyPlatformApi`
 * (so it can't reuse that client's transport-level stitch). Lets the advisors
 * runtime provide one shared stitcher and lets tests mock it directly.
 */
export class LegacyIdentityStitch extends Context.Service<
  LegacyIdentityStitch,
  LegacyIdentityStitchShape
>()("supabase/legacy/IdentityStitch") {}

export const legacyIdentityStitchLayer = Layer.effect(
  LegacyIdentityStitch,
  Effect.gen(function* () {
    const stitch = yield* makeLegacyIdentityStitcher;
    return LegacyIdentityStitch.of({ stitch });
  }),
);
