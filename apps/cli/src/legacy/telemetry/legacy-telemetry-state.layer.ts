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
  /**
   * Exact decoded `schema_version` token, carried for re-serialization and
   * stripped from the written JSON by {@link serializeLegacyTelemetryState}.
   * Go decodes the field into a 64-bit `int` and `json.Marshal` re-emits it
   * verbatim; a JS `Number` above 2^53 rounds (9007199254740993 → …992) and
   * would persist the altered version.
   */
  readonly schemaVersionToken?: string;
}

const SCHEMA_VERSION = 1;
const SESSION_ROTATION_MS = 30 * 60 * 1000;

function legacyTelemetryPath(env: Record<string, string | undefined>, pathSvc: Path.Path): string {
  return pathSvc.join(legacySupabaseHome(homedir(), env), "telemetry.json");
}

/**
 * Serializes the state like Go's `json.Marshal` of `State` (`state.go:25-31`):
 * a carried exact `schema_version` token is spliced back in verbatim via
 * `JSON.rawJSON` (review r3683813242 — `Number` rounds valid int64 tokens
 * above 2^53, so `9007199254740993` would persist as `…992` where Go
 * re-encodes the decoded `int` exactly). Field order matches Go's struct.
 */
function serializeLegacyTelemetryState(state: State): string {
  const { schemaVersionToken, ...fields } = state;
  if (schemaVersionToken === undefined) return JSON.stringify(fields);
  return JSON.stringify({ ...fields, schema_version: JSON.rawJSON(schemaVersionToken) });
}

export interface PriorState {
  readonly enabled: boolean;
  readonly device_id: string;
  readonly session_id: string;
  /** Epoch millis of `session_last_active`, from the Go-shape parse below. */
  readonly sessionLastActiveMs: number;
  readonly distinct_id?: string;
  /**
   * Exact raw token of the decoded non-zero `schema_version`, absent when Go
   * would fall back to the `SchemaVersion` constant (`state.go:103-106`).
   * Kept as the token — not a `Number` — so re-serialization is int64-exact.
   */
  readonly schemaVersionToken?: string;
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

const GO_INT64_MIN = -(2n ** 63n);
const GO_INT64_MAX = 2n ** 63n - 1n;
const INT64_TOKEN_RE = /^-?\d+$/;

/**
 * Whether a raw JSON number token would decode into a Go signed 64-bit
 * integer. Go decodes both the consent-form unix millis (`int64`,
 * `state.go:69-85`) and `schema_version` (`int`, 64-bit on every supported
 * platform, `state.go:41`) by unmarshaling the RAW JSON number token, which
 * accepts only lexically-integer decimal tokens within the int64 range:
 * integer-VALUED tokens like `1.0`, `2.0`, and `1e3` are UnmarshalTypeErrors,
 * as are integer tokens outside [-2^63, 2^63-1] (verified against go1.26:
 * `json.Unmarshal` into `int64` rejects `1.0`/`1e3`/`1e100`/
 * `9223372036854775808`, and the repo's own `decodeState` maps each to
 * `errMalformedState` → full regeneration, `state.go:87-90`). `JSON.parse`
 * collapses those tokens to plain integer Numbers, so parsed VALUES alone
 * cannot reproduce Go — validation runs on the raw token text, with exact
 * BigInt bounds (the doubles for int64-max and int64-max+1 are
 * indistinguishable; the tokens are not).
 */
function isInt64Token(token: string): boolean {
  return (
    INT64_TOKEN_RE.test(token) && BigInt(token) >= GO_INT64_MIN && BigInt(token) <= GO_INT64_MAX
  );
}

const JSON_WS = new Set([" ", "\t", "\n", "\r"]);

/**
 * Scans the ROOT object of an already-syntax-validated JSON text (it runs
 * only after `JSON.parse(text)` has succeeded) and returns every
 * `[key, raw value token]` pair in source order — INCLUDING duplicate keys.
 * `JSON.parse` collapses duplicates to the final occurrence before any user
 * code runs (even a stage-3 source-access reviver only ever sees the final
 * token), but Go's `encoding/json` decodes every occurrence in order, so
 * reproducing its behaviour needs the full occurrence list. Keys are
 * unescaped (Go matches the escaped key `"\u0063onsent"` to the `consent`
 * field). Only depth-1 pairs are emitted: a nested `{"x":{"enabled":"bad"}}` never shadows
 * a root field, matching Go's struct decoding. Returns `undefined` when the
 * root is not an object.
 */
function scanRootJsonEntries(
  text: string,
): ReadonlyArray<readonly [key: string, token: string]> | undefined {
  let i = 0;
  const skipWs = (): void => {
    while (i < text.length && JSON_WS.has(text[i] ?? "")) i += 1;
  };
  // The `i < text.length` bounds below are purely defensive — the text is
  // known-valid JSON, so every string and value is well-terminated.
  const skipString = (): void => {
    i += 1; // opening quote
    while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
    i += 1; // closing quote
  };
  const scanValueToken = (): string => {
    const start = i;
    const first = text[i];
    if (first === '"') {
      skipString();
    } else if (first === "{" || first === "[") {
      let depth = 0;
      while (i < text.length) {
        const ch = text[i];
        if (ch === '"') {
          skipString();
          continue;
        }
        if (ch === "{" || ch === "[") depth += 1;
        else if (ch === "}" || ch === "]") depth -= 1;
        i += 1;
        if (depth === 0) break;
      }
    } else {
      // Primitive: true / false / null / number.
      while (i < text.length) {
        const ch = text[i] ?? "";
        if (ch === "," || ch === "}" || JSON_WS.has(ch)) break;
        i += 1;
      }
    }
    return text.slice(start, i);
  };

  skipWs();
  if (text[i] !== "{") return undefined;
  i += 1;
  const entries: Array<readonly [string, string]> = [];
  skipWs();
  if (text[i] === "}") return entries;
  while (i < text.length) {
    skipWs();
    const keyStart = i;
    skipString();
    const key: unknown = JSON.parse(text.slice(keyStart, i));
    skipWs();
    i += 1; // ':'
    skipWs();
    const token = scanValueToken();
    if (typeof key === "string") entries.push([key, token]);
    skipWs();
    if (text[i] !== ",") break; // closing '}'
    i += 1;
  }
  return entries;
}

/**
 * Go's single `json.Unmarshal` into `rawState` (`state.go:34-42`) records an
 * `UnmarshalTypeError` for EVERY wrong-typed occurrence of a known field —
 * even when a later duplicate is valid and overwrites the value — and any
 * such error classifies the whole file as malformed (verified against the
 * repo's own `decodeState` on go1.26:
 * `{"consent":false,"consent":"denied",…}` fails to decode while
 * `{"enabled":true,"enabled":false,…}` decodes cleanly with `Enabled=false`).
 * JSON `null` decodes into every field without error (nil for the pointer
 * fields, no-op for the rest); `session_last_active` is `json.RawMessage` and
 * unknown keys are skipped untyped — any token is fine for those.
 *
 * DOCUMENTED BOUND (review r3689624837): `encoding/json` also matches field
 * names case-INsensitively when no exact match exists, so Go would treat a
 * hand-edited `"Enabled": …` as the `enabled` field where this port (here and
 * in `lastToken`/`lastNonNullToken`) treats it as unknown. Both CLIs only
 * ever WRITE canonical lowercase keys, so case-variant keys require a
 * hand-edited file; this emulation intentionally stops at exact tag names —
 * do not extend it to fold casing (that path ends at reproducing
 * `strings.EqualFold`'s Unicode simple folding).
 */
function hasGoDecodableFieldTokens(
  entries: ReadonlyArray<readonly [key: string, token: string]>,
): boolean {
  for (const [key, token] of entries) {
    switch (key) {
      case "enabled": // *bool
        if (token !== "true" && token !== "false" && token !== "null") return false;
        break;
      case "consent": // *string
      case "device_id": // string
      case "session_id": // string
      case "distinct_id": // string
        if (!token.startsWith('"') && token !== "null") return false;
        break;
      case "schema_version": // int — Go parses the raw token as base-10 int64
        if (token !== "null" && !isInt64Token(token)) return false;
        break;
      default:
        break;
    }
  }
  return true;
}

/** Raw token of the LAST occurrence of `key` (plain overwrite semantics). */
function lastToken(
  entries: ReadonlyArray<readonly [key: string, token: string]>,
  key: string,
): string | undefined {
  let result: string | undefined;
  for (const [k, token] of entries) {
    if (k === key) result = token;
  }
  return result;
}

/**
 * Raw token of the last NON-NULL occurrence of `key`. This is Go's effective
 * value for the non-pointer `rawState` fields: JSON `null` is a decode no-op
 * (the field keeps its previous value), so `{"device_id":"a","device_id":null}`
 * keeps `"a"` where `JSON.parse` surfaces `null` (verified against go1.26).
 */
function lastNonNullToken(
  entries: ReadonlyArray<readonly [key: string, token: string]>,
  key: string,
): string | undefined {
  let result: string | undefined;
  for (const [k, token] of entries) {
    if (k === key && token !== "null") result = token;
  }
  return result;
}

function lastNonNullString(
  entries: ReadonlyArray<readonly [key: string, token: string]>,
  key: string,
): string | undefined {
  const token = lastNonNullToken(entries, key);
  if (token === undefined) return undefined;
  // The token was validated as a JSON string by `hasGoDecodableFieldTokens`;
  // the typeof narrow keeps the typing honest without a cast.
  const value: unknown = JSON.parse(token);
  return typeof value === "string" ? value : undefined;
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
 * Go's unmarshal strictness is reproduced at the TOKEN level, over EVERY
 * occurrence of every root field ({@link scanRootJsonEntries} +
 * {@link hasGoDecodableFieldTokens}): `JSON.parse` collapses `2.0` → `2`,
 * `1e3` → `1000`, and duplicated keys down to their final occurrence, so
 * parsed values alone would preserve files Go rejects as wholly malformed —
 * non-integer number tokens, magnitudes outside the int64 range, and
 * wrong-typed non-final duplicates (`{"consent":false,"consent":"denied"}`)
 * alike. (Unix millis in-range but beyond ECMAScript's ±8.64e15 `Date` range
 * do NOT regenerate: the epoch is kept as a plain number, so — like Go's
 * `time.UnixMilli` — the state is preserved and the far-future comparison
 * simply never expires the session.)
 */
export function readExistingState(text: string): PriorState | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) return undefined;
    const record = parsed;

    // Per-OCCURRENCE typing first: Go's single-shot unmarshal fails on any
    // wrong-typed occurrence — including one shadowed by a later valid
    // duplicate that `JSON.parse` would surface (`state.go:88-91`).
    const entries = scanRootJsonEntries(text);
    if (entries === undefined || !hasGoDecodableFieldTokens(entries)) return undefined;

    // Go's `parseConsent` (`state.go:52-67`): a non-null `consent` must be
    // `granted`/`denied` (and unlocks the unix-millis timestamp form);
    // otherwise a bool `enabled` is required. Field TYPING — a non-boolean
    // `enabled`, a non-string `consent`, on any occurrence — was already
    // validated above.
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
    // The field is `json.RawMessage`, so plain last-occurrence overwrite
    // applies (nulls included) and only the FINAL token is ever parsed.
    const rawLastActive = record.session_last_active;
    let sessionLastActiveMs: number;
    if (typeof rawLastActive === "string") {
      const parsedMs = parseGoRfc3339Ms(rawLastActive);
      if (parsedMs === undefined) {
        return undefined;
      }
      sessionLastActiveMs = parsedMs;
    } else if (allowUnixMillis && typeof rawLastActive === "number") {
      const millisToken = lastToken(entries, "session_last_active");
      if (millisToken === undefined || !isInt64Token(millisToken)) {
        return undefined;
      }
      sessionLastActiveMs = rawLastActive;
    } else {
      return undefined;
    }

    // Go: `if raw.DeviceID == "" || raw.SessionID == ""` → "missing identity".
    // Effective values are the last NON-NULL occurrences — `null` decodes as
    // a no-op into these non-pointer string fields.
    const deviceId = lastNonNullString(entries, "device_id");
    if (deviceId === undefined || deviceId === "") return undefined;
    const sessionId = lastNonNullString(entries, "session_id");
    if (sessionId === undefined || sessionId === "") return undefined;

    const distinctId = lastNonNullString(entries, "distinct_id");

    // `SchemaVersion int`: absent (or only null occurrences) → zero value;
    // Go keeps a decoded file's non-zero schema_version (`state.go:103-106`).
    // The zero test and the kept value both use the exact TOKEN — `BigInt`
    // for the comparison, the raw text for re-serialization — because
    // `Number` rounds valid int64 magnitudes above 2^53.
    const schemaVersionToken = lastNonNullToken(entries, "schema_version");
    const keptSchemaVersionToken =
      schemaVersionToken !== undefined && BigInt(schemaVersionToken) !== 0n
        ? schemaVersionToken
        : undefined;

    return {
      enabled,
      device_id: deviceId,
      session_id: sessionId,
      sessionLastActiveMs,
      ...(distinctId !== undefined && distinctId.length > 0 ? { distinct_id: distinctId } : {}),
      ...(keptSchemaVersionToken !== undefined
        ? { schemaVersionToken: keptSchemaVersionToken }
        : {}),
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
      // The numeric field is for in-memory readers; the exact token rides
      // along for the write so magnitudes above 2^53 round-trip like Go.
      schema_version:
        prior?.schemaVersionToken !== undefined ? Number(prior.schemaVersionToken) : SCHEMA_VERSION,
      ...(prior?.schemaVersionToken !== undefined
        ? { schemaVersionToken: prior.schemaVersionToken }
        : {}),
    };

    yield* fs.makeDirectory(pathSvc.dirname(filePath), { recursive: true });
    yield* fs.writeFileString(filePath, serializeLegacyTelemetryState(state));
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
  yield* fs.writeFileString(filePath, serializeLegacyTelemetryState(nextState));
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
  yield* fs.writeFileString(filePath, serializeLegacyTelemetryState(nextState));
});

const persistLegacyIdentityReset = Effect.fn("legacy.telemetry.persistIdentityReset")(function* () {
  const base = yield* loadOrCreateLegacyTelemetryState();
  const fs = yield* FileSystem.FileSystem;
  const pathSvc = yield* Path.Path;
  const { distinct_id: _drop, ...rest } = base;
  const nextState: State = { ...rest, device_id: crypto.randomUUID() };
  const filePath = legacyTelemetryPath(process.env, pathSvc);
  yield* fs.makeDirectory(pathSvc.dirname(filePath), { recursive: true });
  yield* fs.writeFileString(filePath, serializeLegacyTelemetryState(nextState));
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
