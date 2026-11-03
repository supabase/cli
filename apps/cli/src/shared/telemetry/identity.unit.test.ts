import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { Clock, Effect, FileSystem, Path, Schema } from "effect";
import { useTempWorkdir } from "../../../tests/helpers/command-mocks.ts";
import { makeTelemetryIdentity, resetIdentity, resolveIdentity } from "./identity.ts";
import { TelemetryConfigSchema, type TelemetryConfig } from "./types.ts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const TelemetryConfigJson = Schema.fromJsonString(TelemetryConfigSchema);

const writeConfig = (dir: string, config: TelemetryConfig) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(dir, { recursive: true });
    yield* fs.writeFileString(
      path.join(dir, "telemetry.json"),
      yield* Schema.encodeEffect(TelemetryConfigJson)(config),
    );
  });

const readConfig = (dir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const content = yield* fs.readFileString(path.join(dir, "telemetry.json"));
    return yield* Schema.decodeEffect(TelemetryConfigJson)(content);
  });

const fsLayer = BunServices.layer;

const tempRoot = useTempWorkdir("supabase-identity-test-");

describe("resolveIdentity", () => {
  it.effect("generates new device_id on first run", () =>
    Effect.gen(function* () {
      const { deviceId } = yield* resolveIdentity(tempRoot.current);
      expect(deviceId).toMatch(UUID_PATTERN);
    }).pipe(Effect.provide(fsLayer)),
  );

  it.effect("generates new session_id on first run", () =>
    Effect.gen(function* () {
      const { sessionId } = yield* resolveIdentity(tempRoot.current);
      expect(sessionId).toMatch(UUID_PATTERN);
    }).pipe(Effect.provide(fsLayer)),
  );

  it.effect("isFirstRun is true on first call", () =>
    Effect.gen(function* () {
      const { isFirstRun } = yield* resolveIdentity(tempRoot.current);
      expect(isFirstRun).toBe(true);
    }).pipe(Effect.provide(fsLayer)),
  );

  it.effect("writes config on first run with granted consent", () =>
    Effect.gen(function* () {
      const dir = tempRoot.current;
      yield* resolveIdentity(dir);
      const config = yield* readConfig(dir);
      expect(config.consent).toBe("granted");
      expect(config.device_id).toMatch(UUID_PATTERN);
      expect(config.session_id).toMatch(UUID_PATTERN);
    }).pipe(Effect.provide(fsLayer)),
  );

  it.effect("preserves device_id across runs", () =>
    Effect.gen(function* () {
      const dir = tempRoot.current;
      yield* writeConfig(dir, {
        consent: "granted",
        device_id: "existing-device-id",
        session_id: "existing-session-id",
        session_last_active: yield* Clock.currentTimeMillis,
      });
      const { deviceId } = yield* resolveIdentity(dir);
      expect(deviceId).toBe("existing-device-id");
    }).pipe(Effect.provide(fsLayer)),
  );

  it.effect("isFirstRun is false on subsequent runs", () =>
    Effect.gen(function* () {
      const dir = tempRoot.current;
      yield* writeConfig(dir, {
        consent: "granted",
        device_id: "existing-device-id",
        session_id: "existing-session-id",
        session_last_active: yield* Clock.currentTimeMillis,
      });
      const { isFirstRun } = yield* resolveIdentity(dir);
      expect(isFirstRun).toBe(false);
    }).pipe(Effect.provide(fsLayer)),
  );

  it.effect("preserves session_id within 30min", () =>
    Effect.gen(function* () {
      const dir = tempRoot.current;
      yield* writeConfig(dir, {
        consent: "granted",
        device_id: "existing-device-id",
        session_id: "existing-session-id",
        session_last_active: (yield* Clock.currentTimeMillis) - 10 * 60 * 1000,
      });
      const { sessionId } = yield* resolveIdentity(dir);
      expect(sessionId).toBe("existing-session-id");
    }).pipe(Effect.provide(fsLayer)),
  );

  it.effect("rotates session_id after 30min idle", () =>
    Effect.gen(function* () {
      const dir = tempRoot.current;
      yield* writeConfig(dir, {
        consent: "granted",
        device_id: "existing-device-id",
        session_id: "old-session-id",
        session_last_active: (yield* Clock.currentTimeMillis) - 31 * 60 * 1000,
      });
      const { sessionId } = yield* resolveIdentity(dir);
      expect(sessionId).not.toBe("old-session-id");
      expect(sessionId).toMatch(UUID_PATTERN);
    }).pipe(Effect.provide(fsLayer)),
  );

  it.effect("updates session_last_active on every call", () =>
    Effect.gen(function* () {
      const dir = tempRoot.current;
      const before = yield* Clock.currentTimeMillis;
      yield* writeConfig(dir, {
        consent: "granted",
        device_id: "existing-device-id",
        session_id: "existing-session-id",
        session_last_active: (yield* Clock.currentTimeMillis) - 5000,
      });
      yield* resolveIdentity(dir);
      const config = yield* readConfig(dir);
      expect(config.session_last_active).toBeGreaterThanOrEqual(before);
    }).pipe(Effect.provide(fsLayer)),
  );
});

describe("resetIdentity", () => {
  it.effect("rotates the persisted device_id and drops the distinct_id", () =>
    Effect.gen(function* () {
      const dir = tempRoot.current;
      yield* writeConfig(dir, {
        consent: "granted",
        device_id: "old-device-id",
        session_id: "session-id",
        session_last_active: yield* Clock.currentTimeMillis,
        distinct_id: "user-a",
      });
      yield* resetIdentity(dir);
      const config = yield* readConfig(dir);
      expect(config.distinct_id).toBeUndefined();
      expect(config.device_id).not.toBe("old-device-id");
      expect(config.consent).toBe("granted");
    }).pipe(Effect.provide(fsLayer)),
  );
});

describe("makeTelemetryIdentity", () => {
  it("starts with the persisted distinct_id when given one", () => {
    const identity = makeTelemetryIdentity("disk-user");
    expect(identity.current()).toBe("disk-user");
  });

  it("starts empty when nothing is persisted", () => {
    const identity = makeTelemetryIdentity(undefined);
    expect(identity.current()).toBeUndefined();
  });

  it("stamp overrides the persisted snapshot for the rest of the process", () => {
    const identity = makeTelemetryIdentity("disk-user");
    identity.stamp("fresh-user");
    expect(identity.current()).toBe("fresh-user");
  });

  it("clear empties both stamped and snapshot identity", () => {
    const identity = makeTelemetryIdentity("disk-user");
    identity.stamp("fresh-user");
    identity.clear();
    expect(identity.current()).toBeUndefined();
  });
});
