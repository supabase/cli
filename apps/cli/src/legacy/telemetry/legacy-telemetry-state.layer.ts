import { Effect, FileSystem, Layer, Path } from "effect";
import { homedir } from "node:os";

import { Analytics } from "../../shared/telemetry/analytics.service.ts";
import { TelemetryRuntime } from "../../shared/telemetry/runtime.service.ts";
import { isEphemeralIdentityRuntime } from "../../shared/telemetry/identity.ts";
import { legacySupabaseHome } from "../config/legacy-profile-file.ts";
import { LegacyTelemetryState } from "./legacy-telemetry-state.service.ts";

interface State {
  readonly enabled: boolean;
  readonly device_id: string;
  readonly session_id: string;
  readonly session_last_active: string;
  readonly distinct_id?: string;
  readonly schema_version: number;
}

const SCHEMA_VERSION = 1;
const SESSION_ROTATION_MS = 30 * 60 * 1000;

function legacyTelemetryPath(env: Record<string, string | undefined>, pathSvc: Path.Path): string {
  return pathSvc.join(legacySupabaseHome(homedir(), env), "telemetry.json");
}

interface PriorState {
  readonly enabled: boolean;
  readonly device_id: string;
  readonly session_id: string;
  readonly session_last_active: string;
  readonly distinct_id?: string;
  readonly schema_version: number;
}

// Go's `time.Parse(time.RFC3339Nano, …)` shape: date, `T`, time, optional
// fraction, `Z` or a `±hh:mm` offset. JS `new Date(…)` alone accepts far more
// (bare dates, RFC 2822, …) that Go rejects as malformed.
const RFC3339_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * Faithful port of Go's `decodeState` (`internal/telemetry/state.go:87-115`):
 * ALL-OR-NOTHING. Go decodes the whole file or classifies it as
 * `errMalformedState` — it never salvages individual fields. A file missing
 * (or mistyping) any required piece — an `enabled` bool (or a
 * `granted`/`denied` `consent`), a parseable `session_last_active`, and
 * non-empty `device_id` AND `session_id` — is treated as wholly malformed, so
 * `LoadOrCreateState` recreates EVERYTHING fresh: `enabled` back to `true`,
 * new `device_id`, new `session_id`. Notably, a corrupt file that still says
 * `"enabled": false` does NOT stay disabled.
 *
 * Two Go strictness corners are not reproducible here: `JSON.parse` collapses
 * `2.0` → `2`, so an integer-valued float `schema_version`/millis passes where
 * Go's unmarshal-into-int rejects it; and `enabled`'s type is only checked on
 * the non-consent path, where Go's single-shot `json.Unmarshal` type-checks
 * every field regardless. Both require a hand-corrupted file the CLI never
 * writes.
 */
function readExistingState(text: string): PriorState | undefined {
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    const record = parsed as Record<string, unknown>;

    // Go's `parseConsent` (`state.go:52-67`): a non-null `consent` must be
    // `granted`/`denied` (and unlocks the unix-millis timestamp form);
    // otherwise a bool `enabled` is required.
    let enabled: boolean;
    let allowUnixMillis = false;
    const consent = record.consent;
    if (consent !== undefined && consent !== null) {
      if (consent === "granted") {
        enabled = true;
        allowUnixMillis = true;
      } else if (consent === "denied") {
        enabled = false;
        allowUnixMillis = true;
      } else {
        return undefined;
      }
    } else if (typeof record.enabled === "boolean") {
      enabled = record.enabled;
    } else {
      return undefined;
    }

    // Go's `parseSessionLastActive` (`state.go:69-85`): an RFC3339Nano string,
    // or — only on the consent form — integer unix millis.
    const rawLastActive = record.session_last_active;
    let sessionLastActive: string;
    if (typeof rawLastActive === "string") {
      if (!RFC3339_RE.test(rawLastActive) || !Number.isFinite(Date.parse(rawLastActive))) {
        return undefined;
      }
      sessionLastActive = rawLastActive;
    } else if (allowUnixMillis && typeof rawLastActive === "number") {
      if (!Number.isInteger(rawLastActive)) return undefined;
      sessionLastActive = new Date(rawLastActive).toISOString();
    } else {
      return undefined;
    }

    // Go: `if raw.DeviceID == "" || raw.SessionID == ""` → "missing identity".
    if (typeof record.device_id !== "string" || record.device_id === "") return undefined;
    if (typeof record.session_id !== "string" || record.session_id === "") return undefined;

    // `DistinctID string` / `SchemaVersion int`: absent → zero value; a wrong
    // JSON type is a field-level unmarshal error → malformed.
    if (
      record.distinct_id !== undefined &&
      record.distinct_id !== null &&
      typeof record.distinct_id !== "string"
    ) {
      return undefined;
    }
    if (
      record.schema_version !== undefined &&
      record.schema_version !== null &&
      !Number.isInteger(record.schema_version)
    ) {
      return undefined;
    }
    const schemaVersion =
      typeof record.schema_version === "number" && record.schema_version !== 0
        ? record.schema_version
        : SCHEMA_VERSION;

    return {
      enabled,
      device_id: record.device_id,
      session_id: record.session_id,
      session_last_active: sessionLastActive,
      ...(typeof record.distinct_id === "string" && record.distinct_id.length > 0
        ? { distinct_id: record.distinct_id }
        : {}),
      schema_version: schemaVersion,
    };
  } catch {
    return undefined;
  }
}

export const loadOrCreateLegacyTelemetryState = Effect.fn("legacy.telemetry.loadOrCreateState")(
  function* (opts: { readonly now?: Date } = {}) {
    const fs = yield* FileSystem.FileSystem;
    const pathSvc = yield* Path.Path;
    const filePath = legacyTelemetryPath(process.env, pathSvc);
    const exists = yield* fs.exists(filePath);
    const existing = exists ? yield* fs.readFileString(filePath) : undefined;
    const prior = existing !== undefined ? readExistingState(existing) : undefined;
    const now = opts.now ?? new Date();
    const nowIso = now.toISOString();

    const priorActive =
      prior?.session_last_active !== undefined ? new Date(prior.session_last_active).getTime() : 0;
    const expired =
      !Number.isFinite(priorActive) || now.getTime() - priorActive > SESSION_ROTATION_MS;

    const state: State = {
      enabled: prior?.enabled ?? true,
      device_id: prior?.device_id ?? crypto.randomUUID(),
      session_id:
        !expired && prior?.session_id !== undefined ? prior.session_id : crypto.randomUUID(),
      session_last_active: nowIso,
      ...(prior?.distinct_id !== undefined ? { distinct_id: prior.distinct_id } : {}),
      // Go keeps a decoded file's non-zero schema_version (`state.go:103-106`).
      schema_version: prior?.schema_version ?? SCHEMA_VERSION,
    };

    yield* fs.makeDirectory(pathSvc.dirname(filePath), { recursive: true });
    yield* fs.writeFileString(filePath, JSON.stringify(state));
    return state;
  },
);

export const setLegacyTelemetryEnabled = Effect.fn("legacy.telemetry.setEnabled")(function* (
  enabled: boolean,
  opts: { readonly now?: Date } = {},
) {
  const state = yield* loadOrCreateLegacyTelemetryState(opts);
  if (state.enabled === enabled) return state;

  const fs = yield* FileSystem.FileSystem;
  const pathSvc = yield* Path.Path;
  const nextState: State = { ...state, enabled };
  const filePath = legacyTelemetryPath(process.env, pathSvc);
  yield* fs.makeDirectory(pathSvc.dirname(filePath), { recursive: true });
  yield* fs.writeFileString(filePath, JSON.stringify(nextState));
  return nextState;
});

/**
 * Re-derives the current telemetry state (reusing `loadOrCreateLegacyTelemetryState`'s
 * read / session-rotation / merge — no third copy of that logic) and writes it
 * back with the `distinct_id` field set (`stitchLogin`) or removed
 * (`clearDistinctId`). Mirrors Go's `SaveState(s.state, fsys)` after mutating
 * `s.state.DistinctID` (`service.go:141-150`).
 */
const persistLegacyDistinctId = Effect.fn("legacy.telemetry.persistDistinctId")(function* (
  distinctId: string | undefined,
) {
  const base = yield* loadOrCreateLegacyTelemetryState();
  const fs = yield* FileSystem.FileSystem;
  const pathSvc = yield* Path.Path;
  const { distinct_id: _drop, ...rest } = base;
  const nextState: State =
    distinctId !== undefined && distinctId.length > 0 ? { ...rest, distinct_id: distinctId } : rest;
  const filePath = legacyTelemetryPath(process.env, pathSvc);
  yield* fs.makeDirectory(pathSvc.dirname(filePath), { recursive: true });
  yield* fs.writeFileString(filePath, JSON.stringify(nextState));
});

const persistLegacyIdentityReset = Effect.fn("legacy.telemetry.persistIdentityReset")(function* () {
  const base = yield* loadOrCreateLegacyTelemetryState();
  const fs = yield* FileSystem.FileSystem;
  const pathSvc = yield* Path.Path;
  const { distinct_id: _drop, ...rest } = base;
  const nextState: State = { ...rest, device_id: crypto.randomUUID() };
  const filePath = legacyTelemetryPath(process.env, pathSvc);
  yield* fs.makeDirectory(pathSvc.dirname(filePath), { recursive: true });
  yield* fs.writeFileString(filePath, JSON.stringify(nextState));
});

/**
 * Writes `<SUPABASE_HOME or ~/.supabase>/telemetry.json` on every command run.
 * Mirrors Go's `LoadOrCreateState` (`apps/cli-go/internal/telemetry/state.go:74-98`):
 *
 *  - Reuses an existing `device_id` if the file is present.
 *  - Rotates `session_id` if `session_last_active` is older than 30 minutes.
 *  - Always sets `enabled: true` on a fresh state (matches Go — the field is
 *    only flipped to `false` if the user has run `supabase telemetry disable`,
 *    in which case the prior value is preserved). The
 *    `SUPABASE_TELEMETRY_DISABLED` / `DO_NOT_TRACK` env vars suppress event
 *    delivery, not state-file writes.
 *  - Always writes — Go persists the state file even when telemetry is
 *    disabled; only event delivery is suppressed.
 *
 * Best-effort: filesystem or JSON parse errors are swallowed.
 */
export const legacyTelemetryStateLayer = Layer.effect(
  LegacyTelemetryState,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const pathSvc = yield* Path.Path;
    const analytics = yield* Analytics;
    const runtime = yield* TelemetryRuntime;

    const provide = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) =>
      effect.pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, pathSvc),
      );

    return LegacyTelemetryState.of({
      flush: provide(loadOrCreateLegacyTelemetryState()).pipe(Effect.asVoid, Effect.ignore),
      stitchLogin: (distinctId: string) =>
        // Mirrors Go's `StitchLogin`: the in-memory stamp always happens so
        // subsequent captures in this process carry the user's id; the alias
        // (which merges pre-login history) and the `telemetry.json` write only
        // happen in persistent runtimes. The alias is fire-and-forget so a
        // PostHog delivery error never prevents the `distinct_id` persist.
        Effect.gen(function* () {
          // Alias only the first identity this device ever sees — re-aliasing
          // on re-login would merge a second user into the device's existing
          // person graph in PostHog. Stamp and persist always.
          const current = runtime.identity.current();
          const firstIdentity = current === undefined || current.length === 0;
          runtime.identity.stamp(distinctId);
          if (isEphemeralIdentityRuntime(runtime)) return;
          if (firstIdentity) {
            yield* analytics.alias(distinctId, runtime.deviceId).pipe(Effect.ignore);
          }
          yield* provide(persistLegacyDistinctId(distinctId));
        }).pipe(Effect.ignore),
      clearDistinctId: Effect.sync(() => {
        runtime.identity.clear();
      }).pipe(
        Effect.andThen(provide(persistLegacyDistinctId(undefined))),
        Effect.asVoid,
        Effect.ignore,
      ),
      resetIdentity: Effect.sync(() => {
        runtime.identity.clear();
      }).pipe(Effect.andThen(provide(persistLegacyIdentityReset())), Effect.asVoid, Effect.ignore),
    });
  }),
);
