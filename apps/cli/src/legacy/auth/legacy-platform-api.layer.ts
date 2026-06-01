import { makeApiClient } from "@supabase/api/effect";
import { Effect, FileSystem, Layer, Option, Path } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import { LegacyCliConfig } from "../config/legacy-cli-config.service.ts";
import { Analytics } from "../../shared/telemetry/analytics.service.ts";
import { TelemetryRuntime } from "../../shared/telemetry/runtime.service.ts";
import { LegacyCredentials } from "./legacy-credentials.service.ts";
import { LegacyPlatformAuthRequiredError } from "./legacy-errors.ts";
import { LegacyPlatformApi } from "./legacy-platform-api.service.ts";

const MISSING_TOKEN_MESSAGE =
  "Access token not provided. Supply an access token by running `supabase login` or setting the SUPABASE_ACCESS_TOKEN environment variable.";

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

const makeLegacyPlatformApiServices = Effect.gen(function* () {
  const cliConfig = yield* LegacyCliConfig;
  const credentials = yield* LegacyCredentials;
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

  const transformClient = (client: HttpClient.HttpClient) =>
    Effect.succeed(
      HttpClient.transform(client, (requestEffect) =>
        requestEffect.pipe(
          Effect.tap((response) => {
            const gotrueId = gotrueIdFromResponse(response);
            if (gotrueId === undefined) return Effect.void;
            return stitchIdentity(gotrueId).pipe(Effect.exit, Effect.asVoid);
          }),
        ),
      ),
    );

  // Env takes precedence over keyring/file (already inside LegacyCredentials), but
  // LegacyCliConfig.accessToken is the env value alone — read in the same order Go uses.
  const configuredToken = cliConfig.accessToken;
  const storedToken = Option.isSome(configuredToken)
    ? configuredToken
    : yield* credentials.getAccessToken;

  if (Option.isNone(storedToken)) {
    return yield* Effect.fail(
      new LegacyPlatformAuthRequiredError({ message: MISSING_TOKEN_MESSAGE }),
    );
  }

  const api = yield* makeApiClient(
    {
      baseUrl: cliConfig.apiUrl,
      accessToken: storedToken.value,
      userAgent: cliConfig.userAgent,
    },
    {
      transformClient,
    },
  );
  return Layer.succeed(LegacyPlatformApi, api);
});

export const legacyPlatformApiLayer = Layer.unwrap(makeLegacyPlatformApiServices);
