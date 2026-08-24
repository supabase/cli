import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { Clock, Effect, FileSystem, Schema } from "effect";
import { makeTelemetryIdentity, resetIdentity, resolveIdentity } from "./identity.ts";
import { TelemetryConfigSchema, type TelemetryConfig } from "./types.ts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const makeTempDir = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.makeTempDirectory({ prefix: "supabase-identity-test-" });
});

const writeConfig = (dir: string, config: TelemetryConfig) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const encoded = yield* Schema.encodeUnknownEffect(Schema.fromJsonString(TelemetryConfigSchema))(
      config,
    );
    yield* fs.makeDirectory(dir, { recursive: true });
    yield* fs.writeFileString(`${dir}/telemetry.json`, encoded);
  });

const readConfig = (dir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const content = yield* fs.readFileString(`${dir}/telemetry.json`);
    return yield* Schema.decodeEffect(Schema.fromJsonString(TelemetryConfigSchema))(content);
  });

const removeTempDir = (dir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.remove(dir, { recursive: true, force: true });
  }).pipe(Effect.ignore);

const fsLayer = BunServices.layer;

const withTempDir = <A, E, R>(use: (dir: string) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const dir = yield* makeTempDir;
    return yield* use(dir).pipe(Effect.ensuring(removeTempDir(dir)));
  }).pipe(Effect.provide(fsLayer));

describe("resolveIdentity", () => {
  it.live("generates new device_id on first run", () => {
    return withTempDir((dir) =>
      Effect.gen(function* () {
        const { deviceId } = yield* resolveIdentity(dir);
        expect(deviceId).toMatch(UUID_PATTERN);
      }),
    );
  });

  it.live("generates new session_id on first run", () => {
    return withTempDir((dir) =>
      Effect.gen(function* () {
        const { sessionId } = yield* resolveIdentity(dir);
        expect(sessionId).toMatch(UUID_PATTERN);
      }),
    );
  });

  it.live("isFirstRun is true on first call", () => {
    return withTempDir((dir) =>
      Effect.gen(function* () {
        const { isFirstRun } = yield* resolveIdentity(dir);
        expect(isFirstRun).toBe(true);
      }),
    );
  });

  it.live("writes config on first run with granted consent", () => {
    return withTempDir((dir) =>
      Effect.gen(function* () {
        yield* resolveIdentity(dir);
        const config = yield* readConfig(dir);
        expect(config.consent).toBe("granted");
        expect(config.device_id).toMatch(UUID_PATTERN);
        expect(config.session_id).toMatch(UUID_PATTERN);
      }),
    );
  });

  it.live("preserves device_id across runs", () => {
    return withTempDir((dir) =>
      Effect.gen(function* () {
        yield* writeConfig(dir, {
          consent: "granted",
          device_id: "existing-device-id",
          session_id: "existing-session-id",
          session_last_active: yield* Clock.currentTimeMillis,
        });
        const { deviceId } = yield* resolveIdentity(dir);
        expect(deviceId).toBe("existing-device-id");
      }),
    );
  });

  it.live("isFirstRun is false on subsequent runs", () => {
    return withTempDir((dir) =>
      Effect.gen(function* () {
        yield* writeConfig(dir, {
          consent: "granted",
          device_id: "existing-device-id",
          session_id: "existing-session-id",
          session_last_active: yield* Clock.currentTimeMillis,
        });
        const { isFirstRun } = yield* resolveIdentity(dir);
        expect(isFirstRun).toBe(false);
      }),
    );
  });

  it.live("preserves session_id within 30min", () => {
    return withTempDir((dir) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        yield* writeConfig(dir, {
          consent: "granted",
          device_id: "existing-device-id",
          session_id: "existing-session-id",
          session_last_active: now - 10 * 60 * 1000,
        });
        const { sessionId } = yield* resolveIdentity(dir);
        expect(sessionId).toBe("existing-session-id");
      }),
    );
  });

  it.live("rotates session_id after 30min idle", () => {
    return withTempDir((dir) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        yield* writeConfig(dir, {
          consent: "granted",
          device_id: "existing-device-id",
          session_id: "old-session-id",
          session_last_active: now - 31 * 60 * 1000,
        });
        const { sessionId } = yield* resolveIdentity(dir);
        expect(sessionId).not.toBe("old-session-id");
        expect(sessionId).toMatch(UUID_PATTERN);
      }),
    );
  });

  it.live("updates session_last_active on every call", () => {
    return withTempDir((dir) =>
      Effect.gen(function* () {
        const before = yield* Clock.currentTimeMillis;
        yield* writeConfig(dir, {
          consent: "granted",
          device_id: "existing-device-id",
          session_id: "existing-session-id",
          session_last_active: before - 5000,
        });
        yield* resolveIdentity(dir);
        const config = yield* readConfig(dir);
        expect(config.session_last_active).toBeGreaterThanOrEqual(before);
      }),
    );
  });
});

describe("resetIdentity", () => {
  it.live("rotates the persisted device_id and drops the distinct_id", () => {
    return withTempDir((dir) =>
      Effect.gen(function* () {
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
      }),
    );
  });
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
