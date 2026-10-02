import { Context, Effect, FileSystem, Layer, Option, Path } from "effect";
import type * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import { Analytics } from "../shared/telemetry/analytics.service.ts";
import { TelemetryRuntime } from "../shared/telemetry/runtime.service.ts";
import { isEphemeralIdentityRuntime } from "../shared/telemetry/identity.ts";
import { readExistingState } from "../telemetry/telemetry-state.layer.ts";

/**
 * Session identity stitching. On the first Management API response of a
 * session carrying `X-Gotrue-Id`, stamps the user id in memory in every
 * runtime (including CI, Docker, `npx supabase`), and on a persistent machine
 * also aliases the device id and persists `distinct_id` to `telemetry.json` —
 * see docs/adr/0013-hybrid-stitch-stamp-identity-attribution.md.
 * {@link IdentityStitch} guards this to at most once per command, shared
 * across every transport (typed client, raw advisor GETs, linked-project
 * cache) that command touches.
 */

const HEADER_GOTRUE_ID = "x-gotrue-id";
const TELEMETRY_SCHEMA_VERSION = 1;

interface TelemetryState {
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

/**
 * Builds a once-per-session stitcher: stamps identity from a response's
 * `X-Gotrue-Id` header, aliasing/persisting `distinct_id` at most once on a
 * persistent machine. Never fails — telemetry is best-effort. Transports must
 * go through the shared {@link IdentityStitch} service instead of building
 * their own, or each gets its own `stitchAttempted` flag.
 */
const makeIdentityStitcher: Effect.Effect<
  {
    readonly stitch: (response: HttpClientResponse.HttpClientResponse) => Effect.Effect<void>;
    readonly stitchedDistinctId: () => string | undefined;
  },
  never,
  Analytics | TelemetryRuntime | FileSystem.FileSystem | Path.Path
> = Effect.gen(function* () {
  const analytics = yield* Analytics;
  const runtime = yield* TelemetryRuntime;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  let stitchAttempted = false;

  const hasIdentity = () => {
    const current = runtime.identity.current();
    return current !== undefined && current.length > 0;
  };

  const stitchIdentity = (gotrueId: string) =>
    Effect.gen(function* () {
      if (runtime.consent !== "granted" || stitchAttempted) return;
      // Mark before the first yield, so concurrent authenticated responses
      // can't both pass the guard and double-stitch.
      stitchAttempted = true;

      if (hasIdentity()) {
        // An identity already exists (from telemetry.json or an earlier
        // response this session): stamp memory so captures carry the live
        // user, but don't re-alias — that would merge unrelated person
        // graphs in PostHog.
        runtime.identity.stamp(gotrueId);
        return;
      }

      const telemetryPath = path.join(runtime.configDir, "telemetry.json");
      const existing = yield* fs.readFileString(telemetryPath).pipe(Effect.option);
      // Uses the same decode as `loadOrCreateTelemetryState` so a
      // `consent: "denied"` file isn't misread as `enabled: true`.
      const prior = Option.match(existing, {
        onNone: () => undefined,
        onSome: readExistingState,
      });
      const enabled = prior?.enabled ?? true;
      if (!enabled) return;

      // Alias and telemetry.json write only happen where the file survives;
      // see docs/adr/0013-hybrid-stitch-stamp-identity-attribution.md.
      runtime.identity.stamp(gotrueId);
      if (isEphemeralIdentityRuntime(runtime)) return;

      yield* analytics.alias(gotrueId, runtime.deviceId);

      const state: TelemetryState = {
        enabled,
        device_id: prior?.device_id ?? runtime.deviceId,
        session_id: prior?.session_id ?? runtime.sessionId,
        session_last_active: new Date().toISOString(),
        distinct_id: gotrueId,
        schema_version:
          prior?.schemaVersionToken !== undefined
            ? Number(prior.schemaVersionToken)
            : TELEMETRY_SCHEMA_VERSION,
      };

      yield* fs.makeDirectory(runtime.configDir, { recursive: true });
      yield* fs.writeFileString(
        telemetryPath,
        // Preserves the prior schema_version's exact int64 token:
        // re-serializing `state.schema_version` through `Number` would round
        // values above 2^53 (e.g. 9007199254740993 → …992).
        prior?.schemaVersionToken === undefined
          ? JSON.stringify(state)
          : JSON.stringify({ ...state, schema_version: JSON.rawJSON(prior.schemaVersionToken) }),
      );
    });

  const stitch = (response: HttpClientResponse.HttpClientResponse) => {
    const gotrueId = gotrueIdFromResponse(response);
    if (gotrueId === undefined) return Effect.void;
    return stitchIdentity(gotrueId).pipe(Effect.exit, Effect.asVoid);
  };

  return { stitch, stitchedDistinctId: () => runtime.identity.current() };
});

interface IdentityStitchShape {
  /** Stitch the session identity from a Management API response, at most once. */
  readonly stitch: (response: HttpClientResponse.HttpClientResponse) => Effect.Effect<void>;
  /**
   * The in-memory identity for this session — the gotrue id stamped from the
   * first authenticated response, the persisted `distinct_id`, or
   * `undefined`. Read after the command runs, once a transport has had a
   * chance to stamp it; since stamping happens in every runtime, this
   * attributes `cli_command_executed` to the real user even without an
   * alias/persist.
   */
  readonly stitchedDistinctId: () => string | undefined;
}

/**
 * The single per-command identity stitcher. Every Management API transport in
 * a command (typed client, raw advisor GETs, linked-project cache) shares
 * this one service so alias/persist happens at most once. Provided once per
 * command runtime via {@link identityStitchLayer} (memoized by reference);
 * tests can mock it directly.
 */
export class IdentityStitch extends Context.Service<IdentityStitch, IdentityStitchShape>()(
  "supabase/cli/IdentityStitch",
) {}

export const identityStitchLayer = Layer.effect(
  IdentityStitch,
  Effect.gen(function* () {
    const { stitch, stitchedDistinctId } = yield* makeIdentityStitcher;
    return IdentityStitch.of({ stitch, stitchedDistinctId });
  }),
);
