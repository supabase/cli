import { Effect, FileSystem, Layer, Path } from "effect";
import { homedir } from "node:os";

import { Analytics } from "../shared/telemetry/analytics.service.ts";
import { TelemetryRuntime } from "../shared/telemetry/runtime.service.ts";
import { isEphemeralIdentityRuntime } from "../shared/telemetry/identity.ts";
import { supabaseHome } from "../config/profile-file.ts";
import { TelemetryState } from "./telemetry-state.service.ts";

interface State {
  readonly enabled: boolean;
  readonly device_id: string;
  readonly session_id: string;
  readonly session_last_active: string;
  readonly distinct_id?: string;
  readonly schema_version: number;
  /**
   * Exact decoded `schema_version` token, carried for re-serialization and stripped from the
   * written JSON by {@link serializeTelemetryState}. `schema_version` is a 64-bit int on disk; a
   * JS `Number` above 2^53 rounds (9007199254740993 → …992) and would persist the altered value.
   */
  readonly schemaVersionToken?: string;
}

const SCHEMA_VERSION = 1;
const SESSION_ROTATION_MS = 30 * 60 * 1000;

function telemetryPath(env: Record<string, string | undefined>, pathSvc: Path.Path): string {
  return pathSvc.join(supabaseHome(homedir(), env), "telemetry.json");
}

/**
 * Serializes the state, splicing a carried exact `schema_version` token back in verbatim via
 * `JSON.rawJSON` — `Number` rounds valid int64 tokens above 2^53, so `9007199254740993` would
 * otherwise persist as `…992`.
 */
function serializeTelemetryState(state: State): string {
  const { schemaVersionToken, ...fields } = state;
  if (schemaVersionToken === undefined) return JSON.stringify(fields);
  return JSON.stringify({ ...fields, schema_version: JSON.rawJSON(schemaVersionToken) });
}

export interface PriorState {
  readonly enabled: boolean;
  readonly device_id: string;
  readonly session_id: string;
  /** Epoch millis of `session_last_active`, from the RFC3339Nano parse below. */
  readonly sessionLastActiveMs: number;
  readonly distinct_id?: string;
  /**
   * Exact raw token of the decoded non-zero `schema_version`, absent when the loader falls back
   * to the `SCHEMA_VERSION` constant. Kept as the token — not a `Number` — so re-serialization is
   * int64-exact.
   */
  readonly schemaVersionToken?: string;
}

// The on-disk RFC3339Nano shape: date, `T`, time, optional fraction, `Z` or a `±hh:mm` offset.
// JS `new Date(…)` alone accepts far more (bare dates, RFC 2822, …) that this format rejects as
// malformed. The fractional separator is `.` or `,`, but the digits after it stay mandatory
// (`…T00:00:00,Z` is rejected).
const RFC3339_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:[.,](\d+))?(?:Z|([+-])(\d{2}):(\d{2}))$/;

const DAYS_PER_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

// Gregorian leap rule.
function daysInMonth(year: number, month: number): number {
  if (month === 2 && year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)) return 29;
  return DAYS_PER_MONTH[month - 1] ?? 0;
}

/**
 * Validates an RFC3339Nano timestamp against the on-disk format's rules and, when valid, returns
 * the epoch milliseconds of the parsed instant. `Date.parse`/`new Date(…)` cannot stand in for it
 * in either direction: JS silently normalizes valid-range day overflow (`2025-02-29` → Mar 1,
 * `T24:00:00Z` → next day) that this format rejects, and it rejects forms this format accepts (a
 * `,` fractional separator; zone offsets bounded at hour 24/minute 60) by returning NaN instead.
 * The epoch therefore also has to come from these components, not a second `new Date(string)`
 * pass, since a valid form JS can't parse would NaN there and wrongly count as session-expired
 * (see the rotation check in `loadOrCreateTelemetryState`).
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
  // At most 9 fractional digits (nanoseconds) are read; ms precision is exact for the 30-minute
  // comparison this feeds.
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
 * Whether a raw JSON number token would decode into a signed 64-bit integer, the type both the
 * consent-form unix millis and `schema_version` are stored as on disk. That format accepts only
 * lexically-integer decimal tokens within the int64 range: integer-valued tokens like `1.0`,
 * `2.0`, and `1e3` are rejected, as are integer tokens outside [-2^63, 2^63-1]. `JSON.parse`
 * collapses those tokens to plain integer Numbers, so parsed values alone can't reproduce this —
 * validation runs on the raw token text, with exact BigInt bounds (the doubles for int64-max and
 * int64-max+1 are indistinguishable; the tokens are not).
 */
function isInt64Token(token: string): boolean {
  return (
    INT64_TOKEN_RE.test(token) && BigInt(token) >= GO_INT64_MIN && BigInt(token) <= GO_INT64_MAX
  );
}

const JSON_WS = new Set([" ", "\t", "\n", "\r"]);

/**
 * Scans the root object of an already-syntax-validated JSON text (it runs only after
 * `JSON.parse(text)` has succeeded) and returns every `[key, raw value token]` pair in source
 * order — including duplicate keys, which `JSON.parse` collapses to the final occurrence before
 * any user code runs. The on-disk format decodes every occurrence in order, so reproducing that
 * needs the full occurrence list. Keys are unescaped (so the escaped key `"\u0063onsent"`
 * matches the `consent` field). Only depth-1 pairs are emitted: a nested
 * `{"x":{"enabled":"bad"}}` never shadows a root field. Returns `undefined` when the root is
 * not an object.
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
 * A wrong-typed occurrence of a known field — even one shadowed by a later valid duplicate — is
 * enough to classify the whole file as malformed on this on-disk format
 * (`{"consent":false,"consent":"denied",…}` fails to decode while
 * `{"enabled":true,"enabled":false,…}` decodes cleanly with `enabled: false`). JSON `null`
 * decodes into every field without error; `session_last_active` is untyped raw JSON and unknown
 * keys are skipped untyped — any token is fine for those.
 *
 * Known bound: this only matches exact lowercase field names. Both CLIs only ever write
 * canonical lowercase keys, so a case-variant key (`"Enabled": …`) requires a hand-edited file and
 * is treated as unknown here rather than folded to `enabled`.
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
 * Raw token of the last non-null occurrence of `key`. JSON `null` is a decode no-op (the field
 * keeps its previous value), so `{"device_id":"a","device_id":null}` keeps `"a"` where
 * `JSON.parse` surfaces `null`.
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
 * Decodes the on-disk telemetry state: all-or-nothing, never salvaging individual fields. A file
 * missing (or mistyping) any required piece — an `enabled` bool (or a `granted`/`denied`
 * `consent`), a parseable `session_last_active`, and non-empty `device_id` and `session_id` — is
 * treated as wholly malformed, so the caller recreates everything fresh: `enabled` back to
 * `true`, new `device_id`, new `session_id`. A corrupt file that still says `"enabled": false`
 * does not stay disabled.
 *
 * Strictness is reproduced at the token level, over every occurrence of every root field
 * ({@link scanRootJsonEntries} + {@link hasGoDecodableFieldTokens}): `JSON.parse` collapses
 * `2.0` → `2`, `1e3` → `1000`, and duplicated keys down to their final occurrence, so parsed
 * values alone would preserve files this format rejects as wholly malformed — non-integer number
 * tokens, magnitudes outside the int64 range, and wrong-typed non-final duplicates
 * (`{"consent":false,"consent":"denied"}`) alike. Unix millis in-range but beyond ECMAScript's
 * ±8.64e15 `Date` range do not regenerate: the epoch is kept as a plain number, so the state is
 * preserved and the far-future comparison simply never expires the session.
 */
export function readExistingState(text: string): PriorState | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) return undefined;
    const record = parsed;

    // Per-occurrence typing first: fails on any wrong-typed occurrence, including one shadowed
    // by a later valid duplicate that `JSON.parse` would surface.
    const entries = scanRootJsonEntries(text);
    if (entries === undefined || !hasGoDecodableFieldTokens(entries)) return undefined;

    // A non-null `consent` must be `granted`/`denied` (and unlocks the unix-millis timestamp
    // form); otherwise a bool `enabled` is required. Field typing was already validated above.
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

    // An RFC3339Nano string, or — only on the consent form — integer unix millis. The field is
    // untyped raw JSON, so plain last-occurrence overwrite applies (nulls included) and only the
    // final token is ever parsed.
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

    // Empty `device_id`/`session_id` means missing identity. Effective values are the last
    // non-null occurrences — `null` decodes as a no-op into these fields.
    const deviceId = lastNonNullString(entries, "device_id");
    if (deviceId === undefined || deviceId === "") return undefined;
    const sessionId = lastNonNullString(entries, "session_id");
    if (sessionId === undefined || sessionId === "") return undefined;

    const distinctId = lastNonNullString(entries, "distinct_id");

    // Absent (or only null occurrences) means zero value; a decoded file's non-zero
    // schema_version is kept. The zero test and the kept value both use the exact token — BigInt
    // for the comparison, the raw text for re-serialization — since `Number` rounds valid int64
    // magnitudes above 2^53.
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

export const loadOrCreateTelemetryState = Effect.fn("telemetry.loadOrCreateState")(function* (
  opts: { readonly now?: Date } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const pathSvc = yield* Path.Path;
  const filePath = telemetryPath(process.env, pathSvc);
  const exists = yield* fs.exists(filePath);
  const existing = exists ? yield* fs.readFileString(filePath) : undefined;
  const prior = existing !== undefined ? readExistingState(existing) : undefined;
  const now = opts.now ?? new Date();
  const nowIso = now.toISOString();

  // The expiry comparison uses the epoch computed by `parseGoRfc3339Ms` during decode, not a
  // `new Date(string)` re-parse — a valid form JS can't parse (comma fraction `…00,5Z`, offsets
  // `+24:00`/`+05:60`) would NaN there and wrongly read as expired, rotating `session_id` even
  // though the instant decoded fine and is still inside the 30-minute window.
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
    // A decoded file's non-zero schema_version is kept. The numeric field is for in-memory
    // readers; the exact token rides along for the write so magnitudes above 2^53 round-trip.
    schema_version:
      prior?.schemaVersionToken !== undefined ? Number(prior.schemaVersionToken) : SCHEMA_VERSION,
    ...(prior?.schemaVersionToken !== undefined
      ? { schemaVersionToken: prior.schemaVersionToken }
      : {}),
  };

  yield* fs.makeDirectory(pathSvc.dirname(filePath), { recursive: true });
  yield* fs.writeFileString(filePath, serializeTelemetryState(state));
  return state;
});

export const setTelemetryEnabled = Effect.fn("telemetry.setEnabled")(function* (
  enabled: boolean,
  opts: { readonly now?: Date } = {},
) {
  const state = yield* loadOrCreateTelemetryState(opts);
  if (state.enabled === enabled) return state;

  const fs = yield* FileSystem.FileSystem;
  const pathSvc = yield* Path.Path;
  const nextState: State = { ...state, enabled };
  const filePath = telemetryPath(process.env, pathSvc);
  yield* fs.makeDirectory(pathSvc.dirname(filePath), { recursive: true });
  yield* fs.writeFileString(filePath, serializeTelemetryState(nextState));
  return nextState;
});

/**
 * Re-derives the current telemetry state (reusing `loadOrCreateTelemetryState`'s read /
 * session-rotation / merge, rather than a third copy of that logic) and writes it back with the
 * `distinct_id` field set (`stitchLogin`) or removed (`clearDistinctId`).
 */
const persistDistinctId = Effect.fn("telemetry.persistDistinctId")(function* (
  distinctId: string | undefined,
) {
  const base = yield* loadOrCreateTelemetryState();
  const fs = yield* FileSystem.FileSystem;
  const pathSvc = yield* Path.Path;
  const { distinct_id: _drop, ...rest } = base;
  const nextState: State =
    distinctId !== undefined && distinctId.length > 0 ? { ...rest, distinct_id: distinctId } : rest;
  const filePath = telemetryPath(process.env, pathSvc);
  yield* fs.makeDirectory(pathSvc.dirname(filePath), { recursive: true });
  yield* fs.writeFileString(filePath, serializeTelemetryState(nextState));
});

const persistIdentityReset = Effect.fn("telemetry.persistIdentityReset")(function* () {
  const base = yield* loadOrCreateTelemetryState();
  const fs = yield* FileSystem.FileSystem;
  const pathSvc = yield* Path.Path;
  const { distinct_id: _drop, ...rest } = base;
  const nextState: State = { ...rest, device_id: crypto.randomUUID() };
  const filePath = telemetryPath(process.env, pathSvc);
  yield* fs.makeDirectory(pathSvc.dirname(filePath), { recursive: true });
  yield* fs.writeFileString(filePath, serializeTelemetryState(nextState));
});

/**
 * Writes `<SUPABASE_HOME or ~/.supabase>/telemetry.json` on every command run:
 *
 *  - Reuses an existing `device_id` if the file is present.
 *  - Rotates `session_id` if `session_last_active` is older than 30 minutes.
 *  - Always sets `enabled: true` on a fresh state — the field is only flipped to `false` if the
 *    user has run `supabase telemetry disable`, in which case the prior value is preserved. The
 *    `SUPABASE_TELEMETRY_DISABLED`/`DO_NOT_TRACK` env vars suppress event delivery, not
 *    state-file writes.
 *  - Always writes, even when telemetry is disabled; only event delivery is suppressed.
 *
 * Best-effort: filesystem or JSON parse errors are swallowed.
 */
export const telemetryStateLayer = Layer.effect(
  TelemetryState,
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

    return TelemetryState.of({
      flush: provide(loadOrCreateTelemetryState()).pipe(Effect.asVoid, Effect.ignore),
      stitchLogin: (distinctId: string) =>
        // The in-memory stamp always happens so subsequent captures in this process carry the
        // user's id; the alias (which merges pre-login history) and the `telemetry.json` write
        // only happen in persistent runtimes. The alias is fire-and-forget so a PostHog delivery
        // error never prevents the `distinct_id` persist.
        Effect.gen(function* () {
          // Alias only the first identity this device ever sees — re-aliasing on re-login would
          // merge a second user into the device's existing person graph in PostHog. Stamp and
          // persist always.
          const current = runtime.identity.current();
          const firstIdentity = current === undefined || current.length === 0;
          runtime.identity.stamp(distinctId);
          if (isEphemeralIdentityRuntime(runtime)) return;
          if (firstIdentity) {
            yield* analytics.alias(distinctId, runtime.deviceId).pipe(Effect.ignore);
          }
          yield* provide(persistDistinctId(distinctId));
        }).pipe(Effect.ignore),
      clearDistinctId: Effect.sync(() => {
        runtime.identity.clear();
      }).pipe(Effect.andThen(provide(persistDistinctId(undefined))), Effect.asVoid, Effect.ignore),
      resetIdentity: Effect.sync(() => {
        runtime.identity.clear();
      }).pipe(Effect.andThen(provide(persistIdentityReset())), Effect.asVoid, Effect.ignore),
    });
  }),
);
