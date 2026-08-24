import { BunPath, BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { ConfigProvider, DateTime, Effect, FileSystem, Layer, Path, Schema } from "effect";

import { mockAnalytics } from "../../../tests/helpers/mocks.ts";
import { useLegacyTempWorkdir } from "../../../tests/helpers/legacy-mocks.ts";
import { TelemetryRuntime } from "../../shared/telemetry/runtime.service.ts";
import { makeTelemetryIdentity } from "../../shared/telemetry/identity.ts";
import {
  legacyTelemetryStateLayer,
  loadOrCreateLegacyTelemetryState,
  setLegacyTelemetryEnabled,
} from "./legacy-telemetry-state.layer.ts";
import { LegacyTelemetryState } from "./legacy-telemetry-state.service.ts";

const temp = useLegacyTempWorkdir("supabase-legacy-telemetry-");
const testPath = Effect.runSync(Path.Path.pipe(Effect.provide(BunPath.layer)));
const RECENT_DATE = DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-01T00:10:00Z"));
const RECENT_ISO = "2025-01-01T00:00:00.000Z";
const encodeJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const telemetryPath = () => testPath.join(temp.current, "telemetry.json");
const testConfigLayer = () =>
  ConfigProvider.layer(
    ConfigProvider.fromEnv({
      env: { SUPABASE_HOME: temp.current },
      preserveEmptyStrings: true,
    }),
  );

const testServices = () => Layer.mergeAll(BunServices.layer, testConfigLayer());

const writeState = (text: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(path.dirname(telemetryPath()), { recursive: true });
    yield* fs.writeFileString(telemetryPath(), text);
  }).pipe(Effect.provide(BunServices.layer));

const readFileText = () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.readFileString(telemetryPath());
  }).pipe(Effect.provide(BunServices.layer));

const readState = () =>
  Effect.gen(function* () {
    const text = yield* readFileText();
    return decodeJson(text) as Record<string, unknown>;
  }).pipe(Effect.provide(BunServices.layer));

const stateExists = () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.exists(telemetryPath());
  }).pipe(Effect.provide(BunServices.layer));

function makeRuntime(opts: { isCi?: boolean; isFirstRun?: boolean; isTty?: boolean } = {}) {
  const identity = makeTelemetryIdentity(undefined);
  const layer = Layer.succeed(TelemetryRuntime, {
    configDir: "/tmp",
    tracesDir: "/tmp",
    consent: "granted",
    showDebug: false,
    deviceId: "device-xyz",
    sessionId: "session-1",
    identity,
    isFirstRun: opts.isFirstRun ?? false,
    isTty: opts.isTty ?? false,
    isCi: opts.isCi ?? false,
    os: "linux",
    arch: "x64",
    cliVersion: "0.0.0-dev",
  });
  return { layer, identity };
}

function makeLayer(
  analytics: ReturnType<typeof mockAnalytics>,
  runtime: ReturnType<typeof makeRuntime> = makeRuntime(),
) {
  return legacyTelemetryStateLayer.pipe(
    Layer.provide(BunServices.layer),
    Layer.provide(testConfigLayer()),
    Layer.provide(analytics.layer),
    Layer.provide(runtime.layer),
  );
}

const seedState = (distinctId?: string) =>
  writeState(
    encodeJson({
      enabled: true,
      device_id: "device-xyz",
      session_id: "session-1",
      session_last_active: "2025-01-01T00:00:00Z",
      ...(distinctId !== undefined ? { distinct_id: distinctId } : {}),
      schema_version: 1,
    }),
  );

describe("legacyTelemetryStateLayer.stitchLogin / clearDistinctId", () => {
  it.effect("stitchLogin in a persistent runtime aliases, persists, and stamps", () => {
    const analytics = mockAnalytics();
    const runtime = makeRuntime();
    return Effect.gen(function* () {
      const state = yield* LegacyTelemetryState;
      yield* state.stitchLogin("gotrue-1");
      expect(analytics.aliased).toEqual([{ distinctId: "gotrue-1", alias: "device-xyz" }]);
      expect((yield* readState()).distinct_id).toBe("gotrue-1");
      expect(runtime.identity.current()).toBe("gotrue-1");
    }).pipe(Effect.provide(makeLayer(analytics, runtime)));
  });

  it.effect(
    "stitchLogin in an ephemeral runtime stamps in memory without alias or file write",
    () => {
      const analytics = mockAnalytics();
      const runtime = makeRuntime({ isCi: true });
      return Effect.gen(function* () {
        const state = yield* LegacyTelemetryState;
        yield* state.stitchLogin("gotrue-ci");
        expect(analytics.aliased).toEqual([]);
        expect(yield* stateExists()).toBe(false);
        expect(runtime.identity.current()).toBe("gotrue-ci");
      }).pipe(Effect.provide(makeLayer(analytics, runtime)));
    },
  );

  it.effect("stitchLogin in a first-run non-tty runtime stamps without alias or file write", () => {
    const analytics = mockAnalytics();
    const runtime = makeRuntime({ isFirstRun: true, isTty: false });
    return Effect.gen(function* () {
      const state = yield* LegacyTelemetryState;
      yield* state.stitchLogin("gotrue-npx");
      expect(analytics.aliased).toEqual([]);
      expect(yield* stateExists()).toBe(false);
      expect(runtime.identity.current()).toBe("gotrue-npx");
    }).pipe(Effect.provide(makeLayer(analytics, runtime)));
  });

  it.effect("stitchLogin replaces a stale distinct_id (parity: stale id is replaced)", () => {
    const analytics = mockAnalytics();
    return Effect.gen(function* () {
      yield* seedState("stale-id");
      const state = yield* LegacyTelemetryState;
      yield* state.stitchLogin("fresh-id");
      expect((yield* readState()).distinct_id).toBe("fresh-id");
    }).pipe(Effect.provide(makeLayer(analytics)));
  });

  it.effect("stitchLogin with an existing identity persists and stamps without re-aliasing", () => {
    const analytics = mockAnalytics();
    const runtime = makeRuntime();
    runtime.identity.stamp("user-a");
    return Effect.gen(function* () {
      yield* seedState("user-a");
      const state = yield* LegacyTelemetryState;
      yield* state.stitchLogin("user-b");
      expect(analytics.aliased).toEqual([]);
      expect((yield* readState()).distinct_id).toBe("user-b");
      expect(runtime.identity.current()).toBe("user-b");
    }).pipe(Effect.provide(makeLayer(analytics, runtime)));
  });

  it.effect("resetIdentity rotates the device id and forgets the user", () => {
    const analytics = mockAnalytics();
    const runtime = makeRuntime();
    runtime.identity.stamp("user-a");
    return Effect.gen(function* () {
      yield* seedState("user-a");
      const state = yield* LegacyTelemetryState;
      yield* state.resetIdentity;
      const next = yield* readState();
      expect(next.distinct_id).toBeUndefined();
      expect(next.device_id).not.toBe("device-xyz");
      expect(runtime.identity.current()).toBeUndefined();
    }).pipe(Effect.provide(makeLayer(analytics, runtime)));
  });

  it.effect(
    "clearDistinctId removes the persisted distinct_id and empties the in-process identity",
    () => {
      const analytics = mockAnalytics();
      const runtime = makeRuntime();
      runtime.identity.stamp("to-clear");
      return Effect.gen(function* () {
        yield* seedState("to-clear");
        const state = yield* LegacyTelemetryState;
        yield* state.clearDistinctId;
        expect((yield* readState()).distinct_id).toBeUndefined();
        expect(runtime.identity.current()).toBeUndefined();
      }).pipe(Effect.provide(makeLayer(analytics, runtime)));
    },
  );
});

// Go's `decodeState` (`internal/telemetry/state.go:87-115`) is all-or-nothing:
// any missing/mistyped required field invalidates the WHOLE file, not just that
// field, so `LoadOrCreateState` regenerates enabled/device_id/session_id fresh.
describe("loadOrCreateLegacyTelemetryState (Go decodeState parity: all-or-nothing recovery)", () => {
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

  const runLoad = () =>
    loadOrCreateLegacyTelemetryState({ now: RECENT_DATE }).pipe(Effect.provide(testServices()));
  const runLoadAt = (now: Date) =>
    loadOrCreateLegacyTelemetryState({ now }).pipe(Effect.provide(testServices()));

  it.effect("a bool-only file missing device_id/session_id is wholly regenerated", () => {
    return Effect.gen(function* () {
      yield* writeState(encodeJson({ enabled: false }));
      const state = yield* runLoad();
      expect(state.enabled).toBe(true);
      expect(state.device_id).toMatch(UUID_RE);
      expect(state.session_id).toMatch(UUID_RE);
    });
  });

  it.effect("an empty device_id string invalidates an otherwise-valid file", () => {
    return Effect.gen(function* () {
      yield* writeState(
        encodeJson({
          enabled: false,
          device_id: "",
          session_id: "session-1",
          session_last_active: RECENT_ISO,
          schema_version: 2,
        }),
      );
      const state = yield* runLoad();
      expect(state.enabled).toBe(true);
      expect(state.device_id).toMatch(UUID_RE);
      expect(state.session_id).not.toBe("session-1");
    });
  });

  it.effect("a fully valid file with a recent session is preserved verbatim", () => {
    return Effect.gen(function* () {
      yield* writeState(
        encodeJson({
          enabled: false,
          device_id: "d",
          session_id: "s",
          session_last_active: RECENT_ISO,
          schema_version: 2,
        }),
      );
      const state = yield* runLoad();
      expect(state.enabled).toBe(false);
      expect(state.device_id).toBe("d");
      expect(state.session_id).toBe("s");
      expect(state.schema_version).toBe(2);
    });
  });

  it.effect(
    "the consent form with a unix-millis session_last_active decodes and preserves enabled:false",
    () => {
      return Effect.gen(function* () {
        yield* writeState(
          encodeJson({
            consent: "denied",
            device_id: "d",
            session_id: "s",
            session_last_active: 1750000000000,
          }),
        );
        const state = yield* runLoad();
        expect(state.enabled).toBe(false);
        expect(state.device_id).toBe("d");
      });
    },
  );

  it.effect("a mistyped enabled on the consent form is malformed and is wholly regenerated", () => {
    // Go's single-shot `json.Unmarshal` type-checks `Enabled *bool` even when
    // `consent` decides the value (`state.go:35`, `state.go:88-91`):
    // `"enabled":"invalid"` is an UnmarshalTypeError → errMalformedState →
    // fresh state with telemetry re-enabled and new identities.
    return Effect.gen(function* () {
      yield* writeState(
        encodeJson({
          consent: "denied",
          enabled: "invalid",
          device_id: "d",
          session_id: "s",
          session_last_active: RECENT_ISO,
        }),
      );
      const state = yield* runLoad();
      expect(state.enabled).toBe(true);
      expect(state.device_id).not.toBe("d");
      expect(state.session_id).not.toBe("s");
    });
  });

  it.effect("a null enabled on the consent form decodes and preserves the state", () => {
    // JSON `null` unmarshals cleanly into Go's `Enabled *bool` (nil pointer,
    // no error) and `parseConsent` then honors the consent value — only
    // non-boolean, non-null types invalidate the file.
    return Effect.gen(function* () {
      yield* writeState(
        encodeJson({
          consent: "denied",
          enabled: null,
          device_id: "d",
          session_id: "s",
          session_last_active: RECENT_ISO,
        }),
      );
      const state = yield* runLoad();
      expect(state.enabled).toBe(false);
      expect(state.device_id).toBe("d");
      expect(state.session_id).toBe("s");
    });
  });

  it.effect("an unrecognized consent value is malformed and is wholly regenerated", () => {
    return Effect.gen(function* () {
      yield* writeState(
        encodeJson({
          consent: "maybe",
          device_id: "d",
          session_id: "s",
          session_last_active: RECENT_ISO,
        }),
      );
      const state = yield* runLoad();
      expect(state.enabled).toBe(true);
      expect(state.device_id).not.toBe("d");
      expect(state.session_id).not.toBe("s");
    });
  });

  // Go's `time.Parse(time.RFC3339Nano, …)` rejects calendar-invalid dates
  // ("day out of range" / "hour out of range") that JS `Date.parse` silently
  // normalizes (Feb 29 → Mar 1, T24 → next day) — verified against go1.26.
  // A file carrying one must be wholly regenerated, not preserved.
  it.effect(
    "a calendar-invalid session_last_active (Feb 29, non-leap year) is wholly regenerated",
    () => {
      return Effect.gen(function* () {
        yield* writeState(
          encodeJson({
            enabled: false,
            device_id: "d",
            session_id: "s",
            session_last_active: "2025-02-29T00:00:00Z",
          }),
        );
        const state = yield* runLoad();
        expect(state.enabled).toBe(true);
        expect(state.device_id).toMatch(UUID_RE);
        expect(state.session_id).toMatch(UUID_RE);
      });
    },
  );

  it.effect("a valid leap-day session_last_active decodes and preserves the state", () => {
    return Effect.gen(function* () {
      yield* writeState(
        encodeJson({
          enabled: false,
          device_id: "d",
          session_id: "s",
          session_last_active: "2024-02-29T00:00:00Z",
        }),
      );
      const state = yield* runLoad();
      // The timestamp is long-stale so the session rotates, but the file
      // decoded: enabled/device_id are preserved, exactly like Go.
      expect(state.enabled).toBe(false);
      expect(state.device_id).toBe("d");
    });
  });

  it.effect("an out-of-range hour (T24) in session_last_active is wholly regenerated", () => {
    return Effect.gen(function* () {
      yield* writeState(
        encodeJson({
          enabled: false,
          device_id: "d",
          session_id: "s",
          session_last_active: "2025-01-01T24:00:00Z",
        }),
      );
      const state = yield* runLoad();
      expect(state.enabled).toBe(true);
      expect(state.device_id).not.toBe("d");
    });
  });

  it.effect(
    "a Go-valid zone offset JS cannot parse (+24:00) still decodes and preserves the state",
    () => {
      // Go's parser bounds the offset hour at 24 and minute at 60, so
      // `+24:00` is a VALID Go timestamp — regenerating here (as a plain
      // `Date.parse` validity check would) would wrongly reset `enabled` and
      // rotate the device identity.
      return Effect.gen(function* () {
        yield* writeState(
          encodeJson({
            enabled: false,
            device_id: "d",
            session_id: "s",
            session_last_active: "2025-01-01T00:00:00+24:00",
          }),
        );
        const state = yield* runLoad();
        expect(state.enabled).toBe(false);
        expect(state.device_id).toBe("d");
      });
    },
  );

  it.effect("a Go-valid comma fractional-second separator decodes and preserves the state", () => {
    // Go's `time.Parse(time.RFC3339Nano, …)` accepts `,` as well as `.`
    // before fractional seconds (`commaOrPeriod`, `time/format.go`; verified
    // against go1.26). Classifying this as malformed would regenerate the
    // file with telemetry re-enabled and fresh identities — Go preserves it.
    return Effect.gen(function* () {
      yield* writeState(
        encodeJson({
          enabled: false,
          device_id: "d",
          session_id: "s",
          session_last_active: "2025-01-01T00:00:00,123Z",
        }),
      );
      const state = yield* runLoad();
      expect(state.enabled).toBe(false);
      expect(state.device_id).toBe("d");
    });
  });

  it.effect("a comma with no fractional digits is malformed and is wholly regenerated", () => {
    // Go rejects `…T00:00:00,Z` ("cannot parse \",Z\" as \"Z07:00\"") — the
    // separator only participates when at least one digit follows.
    return Effect.gen(function* () {
      yield* writeState(
        encodeJson({
          enabled: false,
          device_id: "d",
          session_id: "s",
          session_last_active: "2025-01-01T00:00:00,Z",
        }),
      );
      const state = yield* runLoad();
      expect(state.enabled).toBe(true);
      expect(state.device_id).not.toBe("d");
    });
  });

  // Session expiry must be computed from the SAME component-level Go parse
  // that validated the string — a `new Date(string)` re-parse NaNs on
  // Go-valid forms (comma fraction, exotic offsets) and would count them as
  // expired, rotating `session_id` where the Go binary retains it (verified:
  // seeding `<now>,5Z` and running `supabase-go telemetry status` keeps the
  // seeded session id; the TS CLI before this fix rotated it).
  it.effect("a recent comma-fraction timestamp keeps the session id within 30 minutes", () => {
    return Effect.gen(function* () {
      yield* writeState(
        encodeJson({
          enabled: false,
          device_id: "d",
          session_id: "s",
          session_last_active: "2025-01-01T00:00:00,5Z",
        }),
      );
      const state = yield* runLoadAt(
        DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-01T00:10:00Z")),
      );
      expect(state.session_id).toBe("s");
      expect(state.device_id).toBe("d");
      expect(state.enabled).toBe(false);
    });
  });

  it.effect("a Go-exotic +05:60 offset participates in the expiry arithmetic", () => {
    // `+05:60` normalizes to a 6-hour offset in Go, so this instant is
    // 2025-01-01T00:00:00Z — 10 minutes before `now` → session retained.
    // (JS `new Date` returns NaN for minute-60 offsets, which would rotate.)
    return Effect.gen(function* () {
      yield* writeState(
        encodeJson({
          enabled: false,
          device_id: "d",
          session_id: "s",
          session_last_active: "2025-01-01T06:00:00+05:60",
        }),
      );
      const state = yield* runLoadAt(
        DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-01T00:10:00Z")),
      );
      expect(state.session_id).toBe("s");
      expect(state.device_id).toBe("d");
    });
  });

  it.effect("a +24:00 offset shifts the instant a full day back, expiring the session", () => {
    // Wall clock 2025-01-01T00:00:00 at +24:00 is 2024-12-31T00:00:00Z, so at
    // `now` = 2025-01-01T00:10:00Z the session is 24h10m stale → Go rotates.
    // Reading the wall clock as UTC (ignoring the offset) would wrongly
    // retain it. The decoded file is still preserved (enabled/device_id).
    return Effect.gen(function* () {
      yield* writeState(
        encodeJson({
          enabled: false,
          device_id: "d",
          session_id: "s",
          session_last_active: "2025-01-01T00:00:00+24:00",
        }),
      );
      const state = yield* runLoadAt(
        DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-01T00:10:00Z")),
      );
      expect(state.session_id).not.toBe("s");
      expect(state.device_id).toBe("d");
      expect(state.enabled).toBe(false);
    });
  });

  it.effect("consent-form unix millis beyond the JS Date range preserve the state like Go", () => {
    // Go's `time.UnixMilli(9e15)` is a valid far-future instant (~year
    // 287396): the state decodes, and `now.Sub(last)` is hugely negative →
    // never expired, session retained. Kept as a plain number here so the
    // comparison behaves identically (a `Date`/`toISOString` round-trip
    // throws beyond ±8.64e15 and used to regenerate the whole file).
    return Effect.gen(function* () {
      yield* writeState(
        encodeJson({
          consent: "denied",
          device_id: "d",
          session_id: "s",
          session_last_active: 9_000_000_000_000_000,
        }),
      );
      const state = yield* runLoad();
      expect(state.enabled).toBe(false);
      expect(state.device_id).toBe("d");
      expect(state.session_id).toBe("s");
    });
  });

  it.effect("consent-form unix millis beyond the int64 range regenerate everything like Go", () => {
    // Go's `json.Unmarshal` into `int64` rejects the exponent token 1e+100
    // outright (any float/exponent token is an UnmarshalTypeError for int64)
    // → `errMalformedState` → wholesale regeneration: telemetry re-enabled,
    // fresh identities — even though the file said "denied".
    return Effect.gen(function* () {
      yield* writeState(
        encodeJson({
          consent: "denied",
          device_id: "d",
          session_id: "s",
          session_last_active: 1e100,
        }),
      );
      const state = yield* runLoad();
      expect(state.enabled).toBe(true);
      expect(state.device_id).not.toBe("d");
      expect(state.session_id).not.toBe("s");
    });
  });

  it.effect("consent-form unix millis at Go's int64 bounds preserve the state", () => {
    // Hand-built JSON so the raw text pins Go's exact max valid literal
    // 9223372036854775807 (JSON.stringify of the rounded double would emit a
    // different literal). The raw-token check accepts it via exact BigInt
    // bounds — the parsed double rounds to 2^63 and could not distinguish it
    // from Go-invalid 9223372036854775808 (see the companion test below).
    return Effect.gen(function* () {
      yield* writeState(
        '{"consent":"denied","device_id":"d","session_id":"s","session_last_active":9223372036854775807}',
      );
      const state = yield* runLoad();
      expect(state.enabled).toBe(false);
      expect(state.device_id).toBe("d");
      expect(state.session_id).toBe("s");
    });
  });

  it.effect("consent-form unix millis at Go's int64 min decode but expire the session", () => {
    // int64 min -9223372036854775808 = -(2^63) is exactly representable as a
    // double, so this Go-valid literal round-trips precisely. The instant is
    // far past, so — exactly like Go — the file DECODES (enabled/device_id
    // preserved, no wholesale regeneration) while the >30-minute-stale
    // session id rotates.
    return Effect.gen(function* () {
      yield* writeState(
        '{"consent":"denied","device_id":"d","session_id":"s","session_last_active":-9223372036854775808}',
      );
      const state = yield* runLoad();
      expect(state.enabled).toBe(false);
      expect(state.device_id).toBe("d");
      expect(state.session_id).not.toBe("s");
    });
  });

  // Go's `json.Unmarshal` into `int64` validates the raw TOKEN, not the
  // value: `1e3` and `…0.0` are UnmarshalTypeErrors even though `JSON.parse`
  // collapses them to integer Numbers that pass `Number.isInteger` (verified
  // against go1.26 via the repo's own `decodeState`). A value-level check
  // would preserve `consent: "denied"` and the identities where Go
  // regenerates a fresh telemetry-enabled state.
  it.effect("consent-form unix millis written as an exponent token regenerate like Go", () => {
    return Effect.gen(function* () {
      yield* writeState(
        '{"consent":"denied","device_id":"d","session_id":"s","session_last_active":1e3}',
      );
      const state = yield* runLoad();
      expect(state.enabled).toBe(true);
      expect(state.device_id).not.toBe("d");
      expect(state.session_id).not.toBe("s");
    });
  });

  it.effect(
    "consent-form unix millis written as an integer-valued float regenerate like Go",
    () => {
      return Effect.gen(function* () {
        yield* writeState(
          '{"consent":"denied","device_id":"d","session_id":"s","session_last_active":1750000000000.0}',
        );
        const state = yield* runLoad();
        expect(state.enabled).toBe(true);
        expect(state.device_id).not.toBe("d");
        expect(state.session_id).not.toBe("s");
      });
    },
  );

  it.effect("consent-form unix millis one past int64 max regenerate exactly like Go", () => {
    // 9223372036854775808 parses to the SAME double as Go's max valid literal
    // 9223372036854775807 (both round to 2^63), so only the raw token can
    // tell them apart — Go rejects this one with an UnmarshalTypeError.
    return Effect.gen(function* () {
      yield* writeState(
        '{"consent":"denied","device_id":"d","session_id":"s","session_last_active":9223372036854775808}',
      );
      const state = yield* runLoad();
      expect(state.enabled).toBe(true);
      expect(state.device_id).not.toBe("d");
      expect(state.session_id).not.toBe("s");
    });
  });

  it.effect("a non-integer number token nested under an unknown key stays out of scope", () => {
    // The raw-token capture is scoped to the ROOT object by holder identity.
    // Go ignores unknown fields entirely, so a nested `session_last_active`
    // must neither shadow nor invalidate the valid top-level millis.
    return Effect.gen(function* () {
      yield* writeState(
        '{"consent":"denied","device_id":"d","session_id":"s","session_last_active":1750000000000,"extra":{"session_last_active":1.5}}',
      );
      const state = yield* runLoad();
      expect(state.enabled).toBe(false);
      expect(state.device_id).toBe("d");
    });
  });

  it.effect("a schema_version written as an integer-valued float regenerates like Go", () => {
    // `SchemaVersion int` sits in the single-shot unmarshal (`state.go:41`),
    // where the token `1.0` is an UnmarshalTypeError → the WHOLE file is
    // malformed and regenerated, even though `JSON.parse` reads it as 1.
    return Effect.gen(function* () {
      yield* writeState(
        '{"enabled":false,"device_id":"d","session_id":"s","session_last_active":"2026-01-01T00:00:00Z","schema_version":1.0}',
      );
      const state = yield* runLoad();
      expect(state.enabled).toBe(true);
      expect(state.device_id).not.toBe("d");
      expect(state.session_id).not.toBe("s");
    });
  });

  it.effect("a schema_version beyond the int64 range regenerates everything like Go", () => {
    // `SchemaVersion int` sits in the same single-shot unmarshal
    // (`state.go:41`, `state.go:88-90`): an overflowing value malforms the
    // whole file, not just the field.
    return Effect.gen(function* () {
      yield* writeState(
        encodeJson({
          enabled: false,
          device_id: "d",
          session_id: "s",
          session_last_active: RECENT_ISO,
          schema_version: 1e100,
        }),
      );
      const state = yield* runLoad();
      expect(state.enabled).toBe(true);
      expect(state.device_id).not.toBe("d");
      expect(state.session_id).not.toBe("s");
    });
  });

  // Go's single `json.Unmarshal` decodes EVERY occurrence of a duplicated
  // key: values overwrite last-wins, but a wrong-typed occurrence records an
  // UnmarshalTypeError even when a later duplicate is valid — and any error
  // malforms the whole file (`state.go:34-42`, `state.go:88-91`). `JSON.parse`
  // only surfaces the final occurrence, so these matrices are pinned against
  // the repo's own `decodeState` on go1.26.
  describe("duplicate root keys (Go per-occurrence decoding)", () => {
    it.effect("a wrong-typed earlier consent regenerates even when the final one is valid", () => {
      // Go: `cannot unmarshal bool into … rawState.consent of type string` —
      // the file must NOT stay disabled off the surviving `"denied"`.
      return Effect.gen(function* () {
        yield* writeState(
          '{"consent":false,"consent":"denied","session_last_active":1750000000000,"device_id":"d","session_id":"s"}',
        );
        const state = yield* runLoad();
        expect(state.enabled).toBe(true);
        expect(state.device_id).not.toBe("d");
      });
    });

    it.effect("a wrong-typed FINAL consent regenerates too", () => {
      return Effect.gen(function* () {
        yield* writeState(
          '{"consent":"denied","consent":false,"session_last_active":1750000000000,"device_id":"d","session_id":"s"}',
        );
        const state = yield* runLoad();
        expect(state.enabled).toBe(true);
        expect(state.device_id).not.toBe("d");
      });
    });

    it.effect("well-typed duplicate enabled decodes cleanly with last-value-wins", () => {
      return Effect.gen(function* () {
        yield* writeState(
          `{"enabled":true,"enabled":false,"session_last_active":${encodeJson(RECENT_ISO)},"device_id":"d","session_id":"s"}`,
        );
        const state = yield* runLoad();
        expect(state.enabled).toBe(false);
        expect(state.device_id).toBe("d");
        expect(state.session_id).toBe("s");
      });
    });

    it.effect("a non-integer earlier schema_version token regenerates like Go", () => {
      // `1e3` into `SchemaVersion int` is an UnmarshalTypeError on the first
      // occurrence; the valid `2` after it cannot save the file.
      return Effect.gen(function* () {
        yield* writeState(
          '{"consent":"granted","session_last_active":1750000000000,"device_id":"d","session_id":"s","schema_version":1e3,"schema_version":2}',
        );
        const state = yield* runLoad();
        expect(state.device_id).not.toBe("d");
        expect(state.schema_version).toBe(1);
      });
    });

    it.effect("duplicate session_last_active takes the last token (json.RawMessage)", () => {
      // The RawMessage field is never type-checked per occurrence — only the
      // FINAL token is parsed (`state.go:69-85`), so junk before it is fine.
      return Effect.gen(function* () {
        yield* writeState(
          '{"consent":"denied","session_last_active":true,"session_last_active":1750000000000,"device_id":"d","session_id":"s"}',
        );
        const state = yield* runLoad();
        expect(state.enabled).toBe(false);
        expect(state.device_id).toBe("d");
      });
    });

    it.effect(
      "a wrong-typed earlier device_id regenerates even when the final one is valid",
      () => {
        return Effect.gen(function* () {
          yield* writeState(
            `{"enabled":false,"device_id":0,"device_id":"d","session_id":"s","session_last_active":${encodeJson(RECENT_ISO)}}`,
          );
          const state = yield* runLoad();
          expect(state.enabled).toBe(true);
          expect(state.device_id).not.toBe("d");
        });
      },
    );

    it.effect("null occurrences are decode-valid for pointer and string fields alike", () => {
      // `null` → nil for `Enabled *bool` (later duplicate overwrites) and a
      // no-op for `DeviceID string` — no UnmarshalTypeError anywhere.
      return Effect.gen(function* () {
        yield* writeState(
          `{"enabled":null,"enabled":false,"device_id":null,"device_id":"d","session_id":"s","session_last_active":${encodeJson(RECENT_ISO)}}`,
        );
        const state = yield* runLoad();
        expect(state.enabled).toBe(false);
        expect(state.device_id).toBe("d");
        expect(state.session_id).toBe("s");
      });
    });

    it.effect("a null FINAL device_id keeps the earlier value (null is a decode no-op)", () => {
      // Go keeps `DeviceID:"d"` — unmarshaling `null` into a non-pointer
      // string leaves the previous occurrence's value in place, where
      // `JSON.parse`'s last-value-wins would surface `null` and wrongly
      // regenerate.
      return Effect.gen(function* () {
        yield* writeState(
          `{"enabled":false,"device_id":"d","device_id":null,"session_id":"s","session_last_active":${encodeJson(RECENT_ISO)}}`,
        );
        const state = yield* runLoad();
        expect(state.enabled).toBe(false);
        expect(state.device_id).toBe("d");
        expect(state.session_id).toBe("s");
      });
    });

    it.effect("a null FINAL schema_version keeps the earlier non-zero value", () => {
      return Effect.gen(function* () {
        yield* writeState(
          `{"enabled":false,"device_id":"d","session_id":"s","session_last_active":${encodeJson(RECENT_ISO)},"schema_version":7,"schema_version":null}`,
        );
        const state = yield* runLoad();
        expect(state.enabled).toBe(false);
        expect(state.schema_version).toBe(7);
      });
    });

    it.effect("wrong-typed duplicates of UNKNOWN keys never invalidate the file", () => {
      // Go skips unknown fields untyped — no occurrence of `junk` can error.
      return Effect.gen(function* () {
        yield* writeState(
          `{"enabled":false,"junk":false,"junk":"x","device_id":"d","session_id":"s","session_last_active":${encodeJson(RECENT_ISO)}}`,
        );
        const state = yield* runLoad();
        expect(state.enabled).toBe(false);
        expect(state.device_id).toBe("d");
      });
    });

    it.effect("an escaped duplicate key is unescaped before field matching, like Go", () => {
      // encoding/json unescapes key tokens before struct-field matching, so
      // `"consent":false` is a wrong-typed `consent` occurrence.
      return Effect.gen(function* () {
        yield* writeState(
          '{"\\u0063onsent":false,"consent":"denied","session_last_active":1750000000000,"device_id":"d","session_id":"s"}',
        );
        const state = yield* runLoad();
        expect(state.enabled).toBe(true);
        expect(state.device_id).not.toBe("d");
      });
    });
  });
});

describe("exact int64 schema_version round-trip (Go json.Marshal parity)", () => {
  const runLoad = () =>
    loadOrCreateLegacyTelemetryState({ now: RECENT_DATE }).pipe(Effect.provide(testServices()));

  // File contents are hand-built strings: `encodeJson(9007199254740993)`
  // would round inside the test itself, hiding exactly the bug under test.
  const fileWith = (schemaVersionToken: string): string =>
    `{"enabled":false,"device_id":"d","session_id":"s","session_last_active":${encodeJson(
      RECENT_ISO,
    )},"schema_version":${schemaVersionToken}}`;

  it.effect("a valid schema_version above 2^53 is persisted verbatim, like Go's int64", () => {
    // Go decodes 9007199254740993 into `SchemaVersion int` exactly and
    // `json.Marshal` re-emits it verbatim; a `Number` round-trip persists the
    // rounded …992 (review r3683813242).
    return Effect.gen(function* () {
      yield* writeState(fileWith("9007199254740993"));
      yield* runLoad();
      const written = yield* readFileText();
      expect(written).toContain('"schema_version":9007199254740993');
      expect(written).not.toContain("9007199254740992");
    });
  });

  it.effect("the int64 maximum round-trips exactly", () => {
    return Effect.gen(function* () {
      yield* writeState(fileWith("9223372036854775807"));
      yield* runLoad();
      const written = yield* readFileText();
      expect(written).toContain('"schema_version":9223372036854775807');
    });
  });

  it.effect("setLegacyTelemetryEnabled's rewrite also preserves the exact token", () => {
    return Effect.gen(function* () {
      yield* writeState(fileWith("9007199254740993"));
      yield* setLegacyTelemetryEnabled(true).pipe(Effect.provide(testServices()));
      const written = yield* readFileText();
      expect(written).toContain('"enabled":true');
      expect(written).toContain('"schema_version":9007199254740993');
    });
  });

  it.effect("a zero schema_version still falls back to the current constant, like Go", () => {
    return Effect.gen(function* () {
      yield* writeState(fileWith("0"));
      const state = yield* runLoad();
      expect(state.schema_version).toBe(1);
      const written = yield* readFileText();
      expect(written).toContain('"schema_version":1');
    });
  });
});
