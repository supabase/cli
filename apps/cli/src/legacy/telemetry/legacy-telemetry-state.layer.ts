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
  /** Epoch millis of `session_last_active`, from the Go-shape parse below. */
  readonly sessionLastActiveMs: number;
  readonly distinct_id?: string;
  readonly schema_version: number;
}

// Go's `time.Parse(time.RFC3339Nano, …)` shape: date, `T`, time, optional
// fraction, `Z` or a `±hh:mm` offset. JS `new Date(…)` alone accepts far more
// (bare dates, RFC 2822, …) that Go rejects as malformed. The fractional
// separator is `.` OR `,` — Go's parser accepts either (`commaOrPeriod`,
// `time/format.go`; verified against go1.26: `…T00:00:00,1Z` parses) — while
// the digits after it stay mandatory (`…T00:00:00,Z` is rejected).
const RFC3339_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:[.,](\d+))?(?:Z|([+-])(\d{2}):(\d{2}))$/;

const DAYS_PER_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

// Gregorian leap rule, mirroring Go's `isLeap` (`time/time.go`).
function daysInMonth(year: number, month: number): number {
  if (month === 2 && year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)) return 29;
  return DAYS_PER_MONTH[month - 1] ?? 0;
}

/**
 * Component-level port of Go's `time.Parse(time.RFC3339Nano, …)`
 * (`parseSessionLastActive`, `state.go:69-85`): validates like Go and, when
 * valid, returns the epoch milliseconds of the parsed instant. `Date.parse` /
 * `new Date(…)` cannot stand in for it in either direction (verified against
 * go1.26 and Bun 1.3):
 * - JS silently normalizes valid-range day overflow (`2025-02-29` → Mar 1,
 *   `2025-04-31` → May 1) and hour 24 (`T24:00:00Z` → next day) that Go
 *   rejects as "day/hour out of range";
 * - JS rejects forms Go accepts — a `,` fractional separator, and zone
 *   offsets bounded at hour 24 / minute 60 (`+24:00` and `+05:60` both
 *   parse) — where JS returns NaN.
 * The epoch therefore also has to come from these components, NOT from a
 * second `new Date(string)` pass: a Go-valid form JS cannot parse would
 * NaN there and wrongly count as session-expired (see the rotation check in
 * `loadOrCreateLegacyTelemetryState`).
 */
function parseGoRfc3339Ms(text: string): number | undefined {
  const match = RFC3339_RE.exec(text);
  if (match === null) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (month < 1 || month > 12) return undefined;
  if (day < 1 || day > daysInMonth(year, month)) return undefined;
  if (hour > 23 || minute > 59 || second > 59) return undefined;
  if (match[9] !== undefined && (Number(match[9]) > 24 || Number(match[10]) > 60)) return undefined;
  // `setUTCFullYear` (not `Date.UTC`) so years 0000-0099 aren't remapped to
  // 1900-1999; components are already range-checked, so no rollover occurs.
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  // Go reads at most 9 fractional digits (nanoseconds); ms precision is
  // exact for the 30-minute comparison this feeds.
  const fractionMs = match[7] !== undefined ? Number(`0.${match[7].slice(0, 9)}`) * 1000 : 0;
  const offsetMs =
    match[8] !== undefined
      ? (match[8] === "-" ? -1 : 1) * (Number(match[9]) * 3600 + Number(match[10]) * 60) * 1000
      : 0;
  return date.getTime() + fractionMs - offsetMs;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Go decodes both the consent-form unix millis (`int64`, `state.go:69-85`)
 * and `schema_version` (`int`, 64-bit on every supported platform,
 * `state.go:41`) with `json.Unmarshal` into a signed 64-bit integer, so a
 * non-integer or a magnitude outside that range fails the decode and the
 * whole file is malformed → regenerated (`state.go:87-90`). The upper bound
 * is `2 ** 63` INCLUSIVE: `JSON.parse` rounds Go's max valid value
 * 9223372036854775807 up to exactly 2^63 (doubles at that magnitude are
 * 1024 apart), so an exclusive bound would regenerate a file Go accepts.
 * Go-invalid 9223372036854775808 collapses to the same double — that single
 * post-parse value is inherently ambiguous, and inclusive is the closest
 * achievable parity. (int64 min, -(2^63), is exactly representable.)
 */
function isGoInt64(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isInteger(value) && value >= -(2 ** 63) && value <= 2 ** 63
  );
}

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
 * One Go strictness corner is not reproducible here: `JSON.parse` collapses
 * `2.0` → `2` and `1e3` → `1000`, so an integer-valued float / in-range
 * exponent-form `schema_version`/millis passes where Go's unmarshal-into-int
 * rejects it. It requires a hand-corrupted file the CLI never writes.
 * Magnitudes outside Go's int64 range DO regenerate like Go (see
 * {@link isGoInt64}). (Unix millis in-range but beyond ECMAScript's
 * ±8.64e15 `Date` range no longer regenerate: the epoch is kept as a plain
 * number, so — like Go's `time.UnixMilli` — the state is preserved and the
 * far-future comparison simply never expires the session.)
 */
function readExistingState(text: string): PriorState | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) return undefined;
    const record = parsed;

    // Go's single-shot `json.Unmarshal` type-checks `Enabled *bool`
    // (`state.go:35`, `state.go:88-91`) even when consent takes precedence
    // below: a present, non-boolean `enabled` is a field-level unmarshal
    // error → the whole file is malformed. JSON `null` into the pointer
    // field is valid (leaves it nil), so null passes through.
    if (
      record.enabled !== undefined &&
      record.enabled !== null &&
      typeof record.enabled !== "boolean"
    ) {
      return undefined;
    }

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
    // or — only on the consent form — integer unix millis (`time.UnixMilli`).
    const rawLastActive = record.session_last_active;
    let sessionLastActiveMs: number;
    if (typeof rawLastActive === "string") {
      const parsedMs = parseGoRfc3339Ms(rawLastActive);
      if (parsedMs === undefined) {
        return undefined;
      }
      sessionLastActiveMs = parsedMs;
    } else if (allowUnixMillis && typeof rawLastActive === "number") {
      if (!isGoInt64(rawLastActive)) return undefined;
      sessionLastActiveMs = rawLastActive;
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
      !isGoInt64(record.schema_version)
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
      sessionLastActiveMs,
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

    // The expiry comparison uses the epoch computed by `parseGoRfc3339Ms`
    // during decode — NOT a `new Date(string)` re-parse. Go-valid forms JS
    // cannot parse (comma fraction `…00,5Z`, offsets `+24:00`/`+05:60`)
    // would NaN there and read as expired, rotating `session_id` where Go —
    // which decoded the instant fine — retains it inside the 30-minute
    // window (`LoadOrCreateState`, `state.go:140-148`; verified against the
    // Go binary: a recent `…00,5Z` keeps the seeded session id).
    const priorActiveMs = prior?.sessionLastActiveMs;
    const expired =
      priorActiveMs === undefined || now.getTime() - priorActiveMs > SESSION_ROTATION_MS;

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
