import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { afterEach, beforeEach } from "vitest";

import { mockAnalytics } from "../../../tests/helpers/mocks.ts";
import { TelemetryRuntime } from "../../shared/telemetry/runtime.service.ts";
import { makeTelemetryIdentity } from "../../shared/telemetry/identity.ts";
import {
  legacyTelemetryStateLayer,
  loadOrCreateLegacyTelemetryState,
} from "./legacy-telemetry-state.layer.ts";
import { LegacyTelemetryState } from "./legacy-telemetry-state.service.ts";

let tempHome: string;
let prevHome: string | undefined;

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), "supabase-legacy-telemetry-"));
  prevHome = process.env["SUPABASE_HOME"];
  process.env["SUPABASE_HOME"] = tempHome;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env["SUPABASE_HOME"];
  else process.env["SUPABASE_HOME"] = prevHome;
  rmSync(tempHome, { recursive: true, force: true });
});

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
    Layer.provide(analytics.layer),
    Layer.provide(runtime.layer),
  );
}

const telemetryPath = () => join(tempHome, "telemetry.json");
const readState = (): Record<string, unknown> =>
  JSON.parse(readFileSync(telemetryPath(), "utf8")) as Record<string, unknown>;
const seedState = (distinctId?: string) =>
  writeFileSync(
    telemetryPath(),
    JSON.stringify({
      enabled: true,
      device_id: "device-xyz",
      session_id: "session-1",
      session_last_active: new Date().toISOString(),
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
      expect(readState().distinct_id).toBe("gotrue-1");
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
        expect(existsSync(telemetryPath())).toBe(false);
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
      expect(existsSync(telemetryPath())).toBe(false);
      expect(runtime.identity.current()).toBe("gotrue-npx");
    }).pipe(Effect.provide(makeLayer(analytics, runtime)));
  });

  it.effect("stitchLogin replaces a stale distinct_id (parity: stale id is replaced)", () => {
    seedState("stale-id");
    const analytics = mockAnalytics();
    return Effect.gen(function* () {
      const state = yield* LegacyTelemetryState;
      yield* state.stitchLogin("fresh-id");
      expect(readState().distinct_id).toBe("fresh-id");
    }).pipe(Effect.provide(makeLayer(analytics)));
  });

  it.effect("stitchLogin with an existing identity persists and stamps without re-aliasing", () => {
    seedState("user-a");
    const analytics = mockAnalytics();
    const runtime = makeRuntime();
    runtime.identity.stamp("user-a");
    return Effect.gen(function* () {
      const state = yield* LegacyTelemetryState;
      yield* state.stitchLogin("user-b");
      expect(analytics.aliased).toEqual([]);
      expect(readState().distinct_id).toBe("user-b");
      expect(runtime.identity.current()).toBe("user-b");
    }).pipe(Effect.provide(makeLayer(analytics, runtime)));
  });

  it.effect("resetIdentity rotates the device id and forgets the user", () => {
    seedState("user-a");
    const analytics = mockAnalytics();
    const runtime = makeRuntime();
    runtime.identity.stamp("user-a");
    return Effect.gen(function* () {
      const state = yield* LegacyTelemetryState;
      yield* state.resetIdentity;
      const next = readState();
      expect(next.distinct_id).toBeUndefined();
      expect(next.device_id).not.toBe("device-xyz");
      expect(runtime.identity.current()).toBeUndefined();
    }).pipe(Effect.provide(makeLayer(analytics, runtime)));
  });

  it.effect(
    "clearDistinctId removes the persisted distinct_id and empties the in-process identity",
    () => {
      seedState("to-clear");
      const analytics = mockAnalytics();
      const runtime = makeRuntime();
      runtime.identity.stamp("to-clear");
      return Effect.gen(function* () {
        const state = yield* LegacyTelemetryState;
        yield* state.clearDistinctId;
        expect(readState().distinct_id).toBeUndefined();
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

  const runLoad = () => loadOrCreateLegacyTelemetryState().pipe(Effect.provide(BunServices.layer));

  it.effect("a bool-only file missing device_id/session_id is wholly regenerated", () => {
    writeFileSync(telemetryPath(), JSON.stringify({ enabled: false }));
    return Effect.gen(function* () {
      const state = yield* runLoad();
      expect(state.enabled).toBe(true);
      expect(state.device_id).toMatch(UUID_RE);
      expect(state.session_id).toMatch(UUID_RE);
    });
  });

  it.effect("an empty device_id string invalidates an otherwise-valid file", () => {
    writeFileSync(
      telemetryPath(),
      JSON.stringify({
        enabled: false,
        device_id: "",
        session_id: "session-1",
        session_last_active: new Date().toISOString(),
        schema_version: 2,
      }),
    );
    return Effect.gen(function* () {
      const state = yield* runLoad();
      expect(state.enabled).toBe(true);
      expect(state.device_id).toMatch(UUID_RE);
      expect(state.session_id).not.toBe("session-1");
    });
  });

  it.effect("a fully valid file with a recent session is preserved verbatim", () => {
    writeFileSync(
      telemetryPath(),
      JSON.stringify({
        enabled: false,
        device_id: "d",
        session_id: "s",
        session_last_active: new Date().toISOString(),
        schema_version: 2,
      }),
    );
    return Effect.gen(function* () {
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
      writeFileSync(
        telemetryPath(),
        JSON.stringify({
          consent: "denied",
          device_id: "d",
          session_id: "s",
          session_last_active: 1750000000000,
        }),
      );
      return Effect.gen(function* () {
        const state = yield* runLoad();
        expect(state.enabled).toBe(false);
        expect(state.device_id).toBe("d");
      });
    },
  );

  it.effect("an unrecognized consent value is malformed and is wholly regenerated", () => {
    writeFileSync(
      telemetryPath(),
      JSON.stringify({
        consent: "maybe",
        device_id: "d",
        session_id: "s",
        session_last_active: new Date().toISOString(),
      }),
    );
    return Effect.gen(function* () {
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
      writeFileSync(
        telemetryPath(),
        JSON.stringify({
          enabled: false,
          device_id: "d",
          session_id: "s",
          session_last_active: "2025-02-29T00:00:00Z",
        }),
      );
      return Effect.gen(function* () {
        const state = yield* runLoad();
        expect(state.enabled).toBe(true);
        expect(state.device_id).toMatch(UUID_RE);
        expect(state.session_id).toMatch(UUID_RE);
      });
    },
  );

  it.effect("a valid leap-day session_last_active decodes and preserves the state", () => {
    writeFileSync(
      telemetryPath(),
      JSON.stringify({
        enabled: false,
        device_id: "d",
        session_id: "s",
        session_last_active: "2024-02-29T00:00:00Z",
      }),
    );
    return Effect.gen(function* () {
      const state = yield* runLoad();
      // The timestamp is long-stale so the session rotates, but the file
      // decoded: enabled/device_id are preserved, exactly like Go.
      expect(state.enabled).toBe(false);
      expect(state.device_id).toBe("d");
    });
  });

  it.effect("an out-of-range hour (T24) in session_last_active is wholly regenerated", () => {
    writeFileSync(
      telemetryPath(),
      JSON.stringify({
        enabled: false,
        device_id: "d",
        session_id: "s",
        session_last_active: "2025-01-01T24:00:00Z",
      }),
    );
    return Effect.gen(function* () {
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
      writeFileSync(
        telemetryPath(),
        JSON.stringify({
          enabled: false,
          device_id: "d",
          session_id: "s",
          session_last_active: "2025-01-01T00:00:00+24:00",
        }),
      );
      return Effect.gen(function* () {
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
    writeFileSync(
      telemetryPath(),
      JSON.stringify({
        enabled: false,
        device_id: "d",
        session_id: "s",
        session_last_active: "2025-01-01T00:00:00,123Z",
      }),
    );
    return Effect.gen(function* () {
      const state = yield* runLoad();
      expect(state.enabled).toBe(false);
      expect(state.device_id).toBe("d");
    });
  });

  it.effect("a comma with no fractional digits is malformed and is wholly regenerated", () => {
    // Go rejects `…T00:00:00,Z` ("cannot parse \",Z\" as \"Z07:00\"") — the
    // separator only participates when at least one digit follows.
    writeFileSync(
      telemetryPath(),
      JSON.stringify({
        enabled: false,
        device_id: "d",
        session_id: "s",
        session_last_active: "2025-01-01T00:00:00,Z",
      }),
    );
    return Effect.gen(function* () {
      const state = yield* runLoad();
      expect(state.enabled).toBe(true);
      expect(state.device_id).not.toBe("d");
    });
  });
});
