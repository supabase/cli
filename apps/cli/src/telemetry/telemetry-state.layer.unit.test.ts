import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { DateTime, Effect, FileSystem, Layer, Path, Schema } from "effect";

import { useTempWorkdir, withEnvVar } from "../../tests/helpers/command-mocks.ts";
import { mockAnalytics } from "../../tests/helpers/mocks.ts";
import { TelemetryRuntime } from "../shared/telemetry/runtime.service.ts";
import { makeTelemetryIdentity } from "../shared/telemetry/identity.ts";
import {
  telemetryStateLayer,
  loadOrCreateTelemetryState,
  setTelemetryEnabled,
} from "./telemetry-state.layer.ts";
import { TelemetryState } from "./telemetry-state.service.ts";

const tempHome = useTempWorkdir("supabase-telemetry-");

/* The state file resolves under `SUPABASE_HOME`, so point it at this test's temp dir. */
const withTempHome = <A, E, R>(body: Effect.Effect<A, E, R>) =>
  withEnvVar("SUPABASE_HOME", tempHome.current, body);

function makeRuntime(opts: { isCi?: boolean; isFirstRun?: boolean; isTty?: boolean } = {}) {
  const identity = makeTelemetryIdentity(undefined);
  const layer = Layer.succeed(TelemetryRuntime, {
    configDir: "/tmp",
    consent: "granted",
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
  return telemetryStateLayer.pipe(
    Layer.provide(NodeServices.layer),
    Layer.provide(analytics.layer),
    Layer.provide(runtime.layer),
  );
}

const telemetryPath = Effect.gen(function* () {
  const path = yield* Path.Path;
  return path.join(tempHome.current, "telemetry.json");
});
const readTelemetryFile = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFileString(yield* telemetryPath);
}).pipe(Effect.provide(NodeServices.layer));
const telemetryFileExists = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.exists(yield* telemetryPath);
}).pipe(Effect.provide(NodeServices.layer));
const writeTelemetryFile = (contents: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFileString(yield* telemetryPath, contents);
  }).pipe(Effect.provide(NodeServices.layer));
const seedJson = (value: unknown) =>
  Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(value).pipe(
    Effect.flatMap(writeTelemetryFile),
  );
/* `session_last_active` for a session that is current on the Effect clock the loader reads. */
const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
const readState = readTelemetryFile.pipe(
  Effect.flatMap(
    Schema.decodeEffect(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))),
  ),
);
const seedState = (distinctId?: string) =>
  Effect.gen(function* () {
    yield* seedJson({
      enabled: true,
      device_id: "device-xyz",
      session_id: "session-1",
      session_last_active: yield* nowIso,
      ...(distinctId !== undefined ? { distinct_id: distinctId } : {}),
      schema_version: 1,
    });
  });

describe("telemetryStateLayer.stitchLogin / clearDistinctId", () => {
  it.effect("stitchLogin in a persistent runtime aliases, persists, and stamps", () => {
    const analytics = mockAnalytics();
    const runtime = makeRuntime();
    return Effect.gen(function* () {
      const state = yield* TelemetryState;
      yield* state.stitchLogin("gotrue-1");
      expect(analytics.aliased).toEqual([{ distinctId: "gotrue-1", alias: "device-xyz" }]);
      expect((yield* readState).distinct_id).toBe("gotrue-1");
      expect(runtime.identity.current()).toBe("gotrue-1");
    }).pipe(Effect.provide(makeLayer(analytics, runtime)), withTempHome);
  });

  it.effect(
    "stitchLogin in an ephemeral runtime stamps in memory without alias or file write",
    () => {
      const analytics = mockAnalytics();
      const runtime = makeRuntime({ isCi: true });
      return Effect.gen(function* () {
        const state = yield* TelemetryState;
        yield* state.stitchLogin("gotrue-ci");
        expect(analytics.aliased).toEqual([]);
        expect(yield* telemetryFileExists).toBe(false);
        expect(runtime.identity.current()).toBe("gotrue-ci");
      }).pipe(Effect.provide(makeLayer(analytics, runtime)), withTempHome);
    },
  );

  it.effect("stitchLogin in a first-run non-tty runtime stamps without alias or file write", () => {
    const analytics = mockAnalytics();
    const runtime = makeRuntime({ isFirstRun: true, isTty: false });
    return Effect.gen(function* () {
      const state = yield* TelemetryState;
      yield* state.stitchLogin("gotrue-npx");
      expect(analytics.aliased).toEqual([]);
      expect(yield* telemetryFileExists).toBe(false);
      expect(runtime.identity.current()).toBe("gotrue-npx");
    }).pipe(Effect.provide(makeLayer(analytics, runtime)), withTempHome);
  });

  it.effect("stitchLogin replaces a stale distinct_id (parity: stale id is replaced)", () => {
    const analytics = mockAnalytics();
    return Effect.gen(function* () {
      yield* seedState("stale-id");
      const state = yield* TelemetryState;
      yield* state.stitchLogin("fresh-id");
      expect((yield* readState).distinct_id).toBe("fresh-id");
    }).pipe(Effect.provide(makeLayer(analytics)), withTempHome);
  });

  it.effect("stitchLogin with an existing identity persists and stamps without re-aliasing", () => {
    const analytics = mockAnalytics();
    const runtime = makeRuntime();
    runtime.identity.stamp("user-a");
    return Effect.gen(function* () {
      yield* seedState("user-a");
      const state = yield* TelemetryState;
      yield* state.stitchLogin("user-b");
      expect(analytics.aliased).toEqual([]);
      expect((yield* readState).distinct_id).toBe("user-b");
      expect(runtime.identity.current()).toBe("user-b");
    }).pipe(Effect.provide(makeLayer(analytics, runtime)), withTempHome);
  });

  it.effect("resetIdentity rotates the device id and forgets the user", () => {
    const analytics = mockAnalytics();
    const runtime = makeRuntime();
    runtime.identity.stamp("user-a");
    return Effect.gen(function* () {
      yield* seedState("user-a");
      const state = yield* TelemetryState;
      yield* state.resetIdentity;
      const next = yield* readState;
      expect(next.distinct_id).toBeUndefined();
      expect(next.device_id).not.toBe("device-xyz");
      expect(runtime.identity.current()).toBeUndefined();
    }).pipe(Effect.provide(makeLayer(analytics, runtime)), withTempHome);
  });

  it.effect(
    "clearDistinctId removes the persisted distinct_id and empties the in-process identity",
    () => {
      const analytics = mockAnalytics();
      const runtime = makeRuntime();
      runtime.identity.stamp("to-clear");
      return Effect.gen(function* () {
        yield* seedState("to-clear");
        const state = yield* TelemetryState;
        yield* state.clearDistinctId;
        expect((yield* readState).distinct_id).toBeUndefined();
        expect(runtime.identity.current()).toBeUndefined();
      }).pipe(Effect.provide(makeLayer(analytics, runtime)), withTempHome);
    },
  );
});

describe("loadOrCreateTelemetryState (Go decodeState parity: all-or-nothing recovery)", () => {
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

  const runLoad = () =>
    loadOrCreateTelemetryState().pipe(Effect.provide(NodeServices.layer), withTempHome);
  const runLoadAt = (now: DateTime.Utc) =>
    loadOrCreateTelemetryState({ now }).pipe(Effect.provide(NodeServices.layer), withTempHome);

  it.effect("a bool-only file missing device_id/session_id is wholly regenerated", () =>
    Effect.gen(function* () {
      yield* seedJson({ enabled: false });
      const state = yield* runLoad();
      expect(state.enabled).toBe(true);
      expect(state.device_id).toMatch(UUID_RE);
      expect(state.session_id).toMatch(UUID_RE);
    }),
  );

  it.effect("an empty device_id string invalidates an otherwise-valid file", () =>
    Effect.gen(function* () {
      yield* seedJson({
        enabled: false,
        device_id: "",
        session_id: "session-1",
        session_last_active: yield* nowIso,
        schema_version: 2,
      });
      const state = yield* runLoad();
      expect(state.enabled).toBe(true);
      expect(state.device_id).toMatch(UUID_RE);
      expect(state.session_id).not.toBe("session-1");
    }),
  );

  it.effect("a fully valid file with a recent session is preserved verbatim", () =>
    Effect.gen(function* () {
      yield* seedJson({
        enabled: false,
        device_id: "d",
        session_id: "s",
        session_last_active: yield* nowIso,
        schema_version: 2,
      });
      const state = yield* runLoad();
      expect(state.enabled).toBe(false);
      expect(state.device_id).toBe("d");
      expect(state.session_id).toBe("s");
      expect(state.schema_version).toBe(2);
    }),
  );

  it.effect(
    "the consent form with a unix-millis session_last_active decodes and preserves enabled:false",
    () =>
      Effect.gen(function* () {
        yield* seedJson({
          consent: "denied",
          device_id: "d",
          session_id: "s",
          session_last_active: 1750000000000,
        });
        const state = yield* runLoad();
        expect(state.enabled).toBe(false);
        expect(state.device_id).toBe("d");
      }),
  );

  it.effect("a mistyped enabled on the consent form is malformed and is wholly regenerated", () =>
    Effect.gen(function* () {
      yield* seedJson({
        consent: "denied",
        enabled: "invalid",
        device_id: "d",
        session_id: "s",
        session_last_active: yield* nowIso,
      });
      const state = yield* runLoad();
      expect(state.enabled).toBe(true);
      expect(state.device_id).not.toBe("d");
      expect(state.session_id).not.toBe("s");
    }),
  );

  it.effect("a null enabled on the consent form decodes and preserves the state", () =>
    Effect.gen(function* () {
      yield* seedJson({
        consent: "denied",
        enabled: null,
        device_id: "d",
        session_id: "s",
        session_last_active: yield* nowIso,
      });
      const state = yield* runLoad();
      expect(state.enabled).toBe(false);
      expect(state.device_id).toBe("d");
      expect(state.session_id).toBe("s");
    }),
  );

  it.effect("an unrecognized consent value is malformed and is wholly regenerated", () =>
    Effect.gen(function* () {
      yield* seedJson({
        consent: "maybe",
        device_id: "d",
        session_id: "s",
        session_last_active: yield* nowIso,
      });
      const state = yield* runLoad();
      expect(state.enabled).toBe(true);
      expect(state.device_id).not.toBe("d");
      expect(state.session_id).not.toBe("s");
    }),
  );

  it.effect(
    "a calendar-invalid session_last_active (Feb 29, non-leap year) is wholly regenerated",
    () =>
      Effect.gen(function* () {
        yield* seedJson({
          enabled: false,
          device_id: "d",
          session_id: "s",
          session_last_active: "2025-02-29T00:00:00Z",
        });
        const state = yield* runLoad();
        expect(state.enabled).toBe(true);
        expect(state.device_id).toMatch(UUID_RE);
        expect(state.session_id).toMatch(UUID_RE);
      }),
  );

  it.effect("a valid leap-day session_last_active decodes and preserves the state", () =>
    Effect.gen(function* () {
      yield* seedJson({
        enabled: false,
        device_id: "d",
        session_id: "s",
        session_last_active: "2024-02-29T00:00:00Z",
      });
      const state = yield* runLoad();
      expect(state.enabled).toBe(false);
      expect(state.device_id).toBe("d");
    }),
  );

  it.effect("an out-of-range hour (T24) in session_last_active is wholly regenerated", () =>
    Effect.gen(function* () {
      yield* seedJson({
        enabled: false,
        device_id: "d",
        session_id: "s",
        session_last_active: "2025-01-01T24:00:00Z",
      });
      const state = yield* runLoad();
      expect(state.enabled).toBe(true);
      expect(state.device_id).not.toBe("d");
    }),
  );

  it.effect(
    "a Go-valid zone offset JS cannot parse (+24:00) still decodes and preserves the state",
    () =>
      Effect.gen(function* () {
        yield* seedJson({
          enabled: false,
          device_id: "d",
          session_id: "s",
          session_last_active: "2025-01-01T00:00:00+24:00",
        });
        const state = yield* runLoad();
        expect(state.enabled).toBe(false);
        expect(state.device_id).toBe("d");
      }),
  );

  it.effect("a Go-valid comma fractional-second separator decodes and preserves the state", () =>
    Effect.gen(function* () {
      yield* seedJson({
        enabled: false,
        device_id: "d",
        session_id: "s",
        session_last_active: "2025-01-01T00:00:00,123Z",
      });
      const state = yield* runLoad();
      expect(state.enabled).toBe(false);
      expect(state.device_id).toBe("d");
    }),
  );

  it.effect("a comma with no fractional digits is malformed and is wholly regenerated", () =>
    Effect.gen(function* () {
      yield* seedJson({
        enabled: false,
        device_id: "d",
        session_id: "s",
        session_last_active: "2025-01-01T00:00:00,Z",
      });
      const state = yield* runLoad();
      expect(state.enabled).toBe(true);
      expect(state.device_id).not.toBe("d");
    }),
  );

  it.effect("a recent comma-fraction timestamp keeps the session id within 30 minutes", () =>
    Effect.gen(function* () {
      yield* seedJson({
        enabled: false,
        device_id: "d",
        session_id: "s",
        session_last_active: "2025-01-01T00:00:00,5Z",
      });
      const state = yield* runLoadAt(DateTime.makeUnsafe("2025-01-01T00:10:00Z"));
      expect(state.session_id).toBe("s");
      expect(state.device_id).toBe("d");
      expect(state.enabled).toBe(false);
    }),
  );

  it.effect("a Go-exotic +05:60 offset participates in the expiry arithmetic", () =>
    // `+05:60` normalizes to a 6-hour offset, so this instant is 2025-01-01T00:00:00Z — 10
    // minutes before `now`, so the session is retained. (JS `new Date` returns NaN for
    // minute-60 offsets, which would wrongly rotate it.)
    Effect.gen(function* () {
      yield* seedJson({
        enabled: false,
        device_id: "d",
        session_id: "s",
        session_last_active: "2025-01-01T06:00:00+05:60",
      });
      const state = yield* runLoadAt(DateTime.makeUnsafe("2025-01-01T00:10:00Z"));
      expect(state.session_id).toBe("s");
      expect(state.device_id).toBe("d");
    }),
  );

  it.effect("a +24:00 offset shifts the instant a full day back, expiring the session", () =>
    // Wall clock 2025-01-01T00:00:00 at +24:00 is 2024-12-31T00:00:00Z, so at `now` =
    // 2025-01-01T00:10:00Z the session is 24h10m stale and rotates. Reading the wall clock as
    // UTC (ignoring the offset) would wrongly retain it.
    Effect.gen(function* () {
      yield* seedJson({
        enabled: false,
        device_id: "d",
        session_id: "s",
        session_last_active: "2025-01-01T00:00:00+24:00",
      });
      const state = yield* runLoadAt(DateTime.makeUnsafe("2025-01-01T00:10:00Z"));
      expect(state.session_id).not.toBe("s");
      expect(state.device_id).toBe("d");
      expect(state.enabled).toBe(false);
    }),
  );

  it.effect("a year 0001 timestamp is not remapped to 1901, expiring the session", () =>
    Effect.gen(function* () {
      yield* seedJson({
        enabled: false,
        device_id: "d",
        session_id: "s",
        session_last_active: "0001-01-01T00:00:00Z",
      });
      const state = yield* runLoadAt(DateTime.makeUnsafe("1901-01-01T00:10:00Z"));
      expect(state.session_id).not.toBe("s");
      expect(state.device_id).toBe("d");
    }),
  );

  it.effect("consent-form unix millis beyond the JS Date range preserve the state like Go", () =>
    // A far-future instant (~year 287396): the elapsed-time comparison is hugely negative, so
    // the session is never expired and the state decodes. Kept as a plain number here since a
    // `Date`/`toISOString` round-trip throws beyond ±8.64e15.
    Effect.gen(function* () {
      yield* seedJson({
        consent: "denied",
        device_id: "d",
        session_id: "s",
        session_last_active: 9_000_000_000_000_000,
      });
      const state = yield* runLoad();
      expect(state.enabled).toBe(false);
      expect(state.device_id).toBe("d");
      expect(state.session_id).toBe("s");
    }),
  );

  it.effect("consent-form unix millis beyond the int64 range regenerate everything like Go", () =>
    // A float/exponent token (`1e+100`) is rejected outright for an int64 field, so this
    // regenerates wholesale even though the file said "denied".
    Effect.gen(function* () {
      yield* seedJson({
        consent: "denied",
        device_id: "d",
        session_id: "s",
        session_last_active: 1e100,
      });
      const state = yield* runLoad();
      expect(state.enabled).toBe(true);
      expect(state.device_id).not.toBe("d");
      expect(state.session_id).not.toBe("s");
    }),
  );

  it.effect("consent-form unix millis at Go's int64 bounds preserve the state", () =>
    // Hand-built JSON so the raw text pins the exact int64 max literal 9223372036854775807
    // (`JSON.stringify` of the rounded double would emit a different literal). The raw-token
    // check accepts it via exact BigInt bounds — the parsed double rounds to 2^63 and can't be
    // distinguished from the invalid 9223372036854775808 (see the companion test below).
    Effect.gen(function* () {
      yield* writeTelemetryFile(
        '{"consent":"denied","device_id":"d","session_id":"s","session_last_active":9223372036854775807}',
      );
      const state = yield* runLoad();
      expect(state.enabled).toBe(false);
      expect(state.device_id).toBe("d");
      expect(state.session_id).toBe("s");
    }),
  );

  it.effect("consent-form unix millis at Go's int64 min decode but expire the session", () =>
    // int64 min -9223372036854775808 = -(2^63) is exactly representable as a double, so this
    // literal round-trips precisely. The instant is far past, so the file decodes
    // (enabled/device_id preserved, no wholesale regeneration) while the stale session id rotates.
    Effect.gen(function* () {
      yield* writeTelemetryFile(
        '{"consent":"denied","device_id":"d","session_id":"s","session_last_active":-9223372036854775808}',
      );
      const state = yield* runLoad();
      expect(state.enabled).toBe(false);
      expect(state.device_id).toBe("d");
      expect(state.session_id).not.toBe("s");
    }),
  );

  it.effect("consent-form unix millis written as an exponent token regenerate like Go", () =>
    Effect.gen(function* () {
      yield* writeTelemetryFile(
        '{"consent":"denied","device_id":"d","session_id":"s","session_last_active":1e3}',
      );
      const state = yield* runLoad();
      expect(state.enabled).toBe(true);
      expect(state.device_id).not.toBe("d");
      expect(state.session_id).not.toBe("s");
    }),
  );

  it.effect("consent-form unix millis written as an integer-valued float regenerate like Go", () =>
    Effect.gen(function* () {
      yield* writeTelemetryFile(
        '{"consent":"denied","device_id":"d","session_id":"s","session_last_active":1750000000000.0}',
      );
      const state = yield* runLoad();
      expect(state.enabled).toBe(true);
      expect(state.device_id).not.toBe("d");
      expect(state.session_id).not.toBe("s");
    }),
  );

  it.effect("consent-form unix millis one past int64 max regenerate exactly like Go", () =>
    // 9223372036854775808 parses to the same double as the int64 max literal 9223372036854775807
    // (both round to 2^63), so only the raw token can tell them apart.
    Effect.gen(function* () {
      yield* writeTelemetryFile(
        '{"consent":"denied","device_id":"d","session_id":"s","session_last_active":9223372036854775808}',
      );
      const state = yield* runLoad();
      expect(state.enabled).toBe(true);
      expect(state.device_id).not.toBe("d");
      expect(state.session_id).not.toBe("s");
    }),
  );

  it.effect("a non-integer number token nested under an unknown key stays out of scope", () =>
    // The raw-token capture is scoped to the root object by holder identity, and unknown fields
    // are ignored entirely, so a nested `session_last_active` must neither shadow nor invalidate
    // the valid top-level millis.
    Effect.gen(function* () {
      yield* writeTelemetryFile(
        '{"consent":"denied","device_id":"d","session_id":"s","session_last_active":1750000000000,"extra":{"session_last_active":1.5}}',
      );
      const state = yield* runLoad();
      expect(state.enabled).toBe(false);
      expect(state.device_id).toBe("d");
    }),
  );

  it.effect("a schema_version written as an integer-valued float regenerates like Go", () =>
    // `schema_version` is an int field, where the token `1.0` is rejected, so the whole file is
    // malformed and regenerated even though `JSON.parse` reads it as 1.
    Effect.gen(function* () {
      yield* writeTelemetryFile(
        '{"enabled":false,"device_id":"d","session_id":"s","session_last_active":"2026-01-01T00:00:00Z","schema_version":1.0}',
      );
      const state = yield* runLoad();
      expect(state.enabled).toBe(true);
      expect(state.device_id).not.toBe("d");
      expect(state.session_id).not.toBe("s");
    }),
  );

  it.effect("a schema_version beyond the int64 range regenerates everything like Go", () =>
    Effect.gen(function* () {
      yield* seedJson({
        enabled: false,
        device_id: "d",
        session_id: "s",
        session_last_active: yield* nowIso,
        schema_version: 1e100,
      });
      const state = yield* runLoad();
      expect(state.enabled).toBe(true);
      expect(state.device_id).not.toBe("d");
      expect(state.session_id).not.toBe("s");
    }),
  );

  describe("duplicate root keys (Go per-occurrence decoding)", () => {
    it.effect("a wrong-typed earlier consent regenerates even when the final one is valid", () =>
      Effect.gen(function* () {
        yield* writeTelemetryFile(
          '{"consent":false,"consent":"denied","session_last_active":1750000000000,"device_id":"d","session_id":"s"}',
        );
        const state = yield* runLoad();
        expect(state.enabled).toBe(true);
        expect(state.device_id).not.toBe("d");
      }),
    );

    it.effect("a wrong-typed FINAL consent regenerates too", () =>
      Effect.gen(function* () {
        yield* writeTelemetryFile(
          '{"consent":"denied","consent":false,"session_last_active":1750000000000,"device_id":"d","session_id":"s"}',
        );
        const state = yield* runLoad();
        expect(state.enabled).toBe(true);
        expect(state.device_id).not.toBe("d");
      }),
    );

    it.effect("well-typed duplicate enabled decodes cleanly with last-value-wins", () =>
      Effect.gen(function* () {
        yield* writeTelemetryFile(
          `{"enabled":true,"enabled":false,"session_last_active":"${yield* nowIso}","device_id":"d","session_id":"s"}`,
        );
        const state = yield* runLoad();
        expect(state.enabled).toBe(false);
        expect(state.device_id).toBe("d");
        expect(state.session_id).toBe("s");
      }),
    );

    it.effect("a non-integer earlier schema_version token regenerates like Go", () =>
      // `1e3` is rejected for the int field on its first occurrence; the valid `2` after it
      // cannot save the file.
      Effect.gen(function* () {
        yield* writeTelemetryFile(
          '{"consent":"granted","session_last_active":1750000000000,"device_id":"d","session_id":"s","schema_version":1e3,"schema_version":2}',
        );
        const state = yield* runLoad();
        expect(state.device_id).not.toBe("d");
        expect(state.schema_version).toBe(1);
      }),
    );

    it.effect("duplicate session_last_active takes the last token (json.RawMessage)", () =>
      // This field is never type-checked per occurrence — only the final token is parsed, so
      // junk before it is fine.
      Effect.gen(function* () {
        yield* writeTelemetryFile(
          '{"consent":"denied","session_last_active":true,"session_last_active":1750000000000,"device_id":"d","session_id":"s"}',
        );
        const state = yield* runLoad();
        expect(state.enabled).toBe(false);
        expect(state.device_id).toBe("d");
      }),
    );

    it.effect("a wrong-typed earlier device_id regenerates even when the final one is valid", () =>
      Effect.gen(function* () {
        yield* writeTelemetryFile(
          `{"enabled":false,"device_id":0,"device_id":"d","session_id":"s","session_last_active":"${yield* nowIso}"}`,
        );
        const state = yield* runLoad();
        expect(state.enabled).toBe(true);
        expect(state.device_id).not.toBe("d");
      }),
    );

    it.effect("null occurrences are decode-valid for pointer and string fields alike", () =>
      // `null` decodes cleanly for both a boolean field (later duplicate overwrites) and a
      // string field (no-op) — nothing here is rejected.
      Effect.gen(function* () {
        yield* writeTelemetryFile(
          `{"enabled":null,"enabled":false,"device_id":null,"device_id":"d","session_id":"s","session_last_active":"${yield* nowIso}"}`,
        );
        const state = yield* runLoad();
        expect(state.enabled).toBe(false);
        expect(state.device_id).toBe("d");
        expect(state.session_id).toBe("s");
      }),
    );

    it.effect("a null FINAL device_id keeps the earlier value (null is a decode no-op)", () =>
      // `device_id` keeps `"d"` — decoding `null` into this field leaves the previous
      // occurrence's value in place, where `JSON.parse`'s last-value-wins would surface `null`
      // and wrongly regenerate.
      Effect.gen(function* () {
        yield* writeTelemetryFile(
          `{"enabled":false,"device_id":"d","device_id":null,"session_id":"s","session_last_active":"${yield* nowIso}"}`,
        );
        const state = yield* runLoad();
        expect(state.enabled).toBe(false);
        expect(state.device_id).toBe("d");
        expect(state.session_id).toBe("s");
      }),
    );

    it.effect("a null FINAL schema_version keeps the earlier non-zero value", () =>
      Effect.gen(function* () {
        yield* writeTelemetryFile(
          `{"enabled":false,"device_id":"d","session_id":"s","session_last_active":"${yield* nowIso}","schema_version":7,"schema_version":null}`,
        );
        const state = yield* runLoad();
        expect(state.enabled).toBe(false);
        expect(state.schema_version).toBe(7);
      }),
    );

    it.effect("wrong-typed duplicates of UNKNOWN keys never invalidate the file", () =>
      // Unknown fields are skipped untyped, so no occurrence of `junk` can error.
      Effect.gen(function* () {
        yield* writeTelemetryFile(
          `{"enabled":false,"junk":false,"junk":"x","device_id":"d","session_id":"s","session_last_active":"${yield* nowIso}"}`,
        );
        const state = yield* runLoad();
        expect(state.enabled).toBe(false);
        expect(state.device_id).toBe("d");
      }),
    );

    it.effect("an escaped duplicate key is unescaped before field matching, like Go", () =>
      // Key tokens are unescaped before field matching, so `"\u0063onsent":false` is a
      // wrong-typed `consent` occurrence.
      Effect.gen(function* () {
        yield* writeTelemetryFile(
          '{"\\u0063onsent":false,"consent":"denied","session_last_active":1750000000000,"device_id":"d","session_id":"s"}',
        );
        const state = yield* runLoad();
        expect(state.enabled).toBe(true);
        expect(state.device_id).not.toBe("d");
      }),
    );
  });
});

describe("exact int64 schema_version round-trip (Go json.Marshal parity)", () => {
  const runLoad = () =>
    loadOrCreateTelemetryState().pipe(Effect.provide(NodeServices.layer), withTempHome);

  // File contents are hand-built strings: `JSON.stringify(9007199254740993)`
  // would round inside the test itself, hiding exactly the bug under test.
  const fileWith = (schemaVersionToken: string) =>
    nowIso.pipe(
      Effect.map(
        (now) =>
          `{"enabled":false,"device_id":"d","session_id":"s","session_last_active":"${now}","schema_version":${schemaVersionToken}}`,
      ),
    );

  it.effect("a valid schema_version above 2^53 is persisted verbatim, like Go's int64", () =>
    Effect.gen(function* () {
      yield* writeTelemetryFile(yield* fileWith("9007199254740993"));
      yield* runLoad();
      const written = yield* readTelemetryFile;
      expect(written).toContain('"schema_version":9007199254740993');
      expect(written).not.toContain("9007199254740992");
    }),
  );

  it.effect("the int64 maximum round-trips exactly", () =>
    Effect.gen(function* () {
      yield* writeTelemetryFile(yield* fileWith("9223372036854775807"));
      yield* runLoad();
      const written = yield* readTelemetryFile;
      expect(written).toContain('"schema_version":9223372036854775807');
    }),
  );

  it.effect("setTelemetryEnabled's rewrite also preserves the exact token", () =>
    Effect.gen(function* () {
      yield* writeTelemetryFile(yield* fileWith("9007199254740993"));
      yield* setTelemetryEnabled(true).pipe(Effect.provide(NodeServices.layer), withTempHome);
      const written = yield* readTelemetryFile;
      expect(written).toContain('"enabled":true');
      expect(written).toContain('"schema_version":9007199254740993');
    }),
  );

  it.effect("a zero schema_version still falls back to the current constant, like Go", () =>
    Effect.gen(function* () {
      yield* writeTelemetryFile(yield* fileWith("0"));
      const state = yield* runLoad();
      expect(state.schema_version).toBe(1);
      const written = yield* readTelemetryFile;
      expect(written).toContain('"schema_version":1');
    }),
  );
});
