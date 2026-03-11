import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Effect } from "effect";
import { resolveIdentity } from "./identity.ts";
import type { TelemetryConfig } from "./types.ts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function makeTempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "supa-identity-test-"));
}

function writeConfig(dir: string, config: TelemetryConfig): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "telemetry.json"), JSON.stringify(config));
}

function readConfig(dir: string): TelemetryConfig {
  return JSON.parse(readFileSync(path.join(dir, "telemetry.json"), "utf8"));
}

const fsLayer = BunServices.layer;

describe("resolveIdentity", () => {
  it.live("generates new device_id on first run", () => {
    const dir = makeTempDir();
    return Effect.gen(function* () {
      const { deviceId } = yield* resolveIdentity(dir);
      expect(deviceId).toMatch(UUID_PATTERN);
    }).pipe(
      Effect.provide(fsLayer),
      Effect.ensuring(Effect.sync(() => rmSync(dir, { recursive: true, force: true }))),
    );
  });

  it.live("generates new session_id on first run", () => {
    const dir = makeTempDir();
    return Effect.gen(function* () {
      const { sessionId } = yield* resolveIdentity(dir);
      expect(sessionId).toMatch(UUID_PATTERN);
    }).pipe(
      Effect.provide(fsLayer),
      Effect.ensuring(Effect.sync(() => rmSync(dir, { recursive: true, force: true }))),
    );
  });

  it.live("isFirstRun is true on first call", () => {
    const dir = makeTempDir();
    return Effect.gen(function* () {
      const { isFirstRun } = yield* resolveIdentity(dir);
      expect(isFirstRun).toBe(true);
    }).pipe(
      Effect.provide(fsLayer),
      Effect.ensuring(Effect.sync(() => rmSync(dir, { recursive: true, force: true }))),
    );
  });

  it.live("writes config on first run with granted consent", () => {
    const dir = makeTempDir();
    return Effect.gen(function* () {
      yield* resolveIdentity(dir);
      const config = readConfig(dir);
      expect(config.consent).toBe("granted");
      expect(config.device_id).toMatch(UUID_PATTERN);
      expect(config.session_id).toMatch(UUID_PATTERN);
    }).pipe(
      Effect.provide(fsLayer),
      Effect.ensuring(Effect.sync(() => rmSync(dir, { recursive: true, force: true }))),
    );
  });

  it.live("preserves device_id across runs", () => {
    const dir = makeTempDir();
    writeConfig(dir, {
      consent: "granted",
      device_id: "existing-device-id",
      session_id: "existing-session-id",
      session_last_active: Date.now(),
    });
    return Effect.gen(function* () {
      const { deviceId } = yield* resolveIdentity(dir);
      expect(deviceId).toBe("existing-device-id");
    }).pipe(
      Effect.provide(fsLayer),
      Effect.ensuring(Effect.sync(() => rmSync(dir, { recursive: true, force: true }))),
    );
  });

  it.live("isFirstRun is false on subsequent runs", () => {
    const dir = makeTempDir();
    writeConfig(dir, {
      consent: "granted",
      device_id: "existing-device-id",
      session_id: "existing-session-id",
      session_last_active: Date.now(),
    });
    return Effect.gen(function* () {
      const { isFirstRun } = yield* resolveIdentity(dir);
      expect(isFirstRun).toBe(false);
    }).pipe(
      Effect.provide(fsLayer),
      Effect.ensuring(Effect.sync(() => rmSync(dir, { recursive: true, force: true }))),
    );
  });

  it.live("preserves session_id within 30min", () => {
    const dir = makeTempDir();
    writeConfig(dir, {
      consent: "granted",
      device_id: "existing-device-id",
      session_id: "existing-session-id",
      session_last_active: Date.now() - 10 * 60 * 1000,
    });
    return Effect.gen(function* () {
      const { sessionId } = yield* resolveIdentity(dir);
      expect(sessionId).toBe("existing-session-id");
    }).pipe(
      Effect.provide(fsLayer),
      Effect.ensuring(Effect.sync(() => rmSync(dir, { recursive: true, force: true }))),
    );
  });

  it.live("rotates session_id after 30min idle", () => {
    const dir = makeTempDir();
    writeConfig(dir, {
      consent: "granted",
      device_id: "existing-device-id",
      session_id: "old-session-id",
      session_last_active: Date.now() - 31 * 60 * 1000,
    });
    return Effect.gen(function* () {
      const { sessionId } = yield* resolveIdentity(dir);
      expect(sessionId).not.toBe("old-session-id");
      expect(sessionId).toMatch(UUID_PATTERN);
    }).pipe(
      Effect.provide(fsLayer),
      Effect.ensuring(Effect.sync(() => rmSync(dir, { recursive: true, force: true }))),
    );
  });

  it.live("updates session_last_active on every call", () => {
    const dir = makeTempDir();
    const before = Date.now();
    writeConfig(dir, {
      consent: "granted",
      device_id: "existing-device-id",
      session_id: "existing-session-id",
      session_last_active: Date.now() - 5000,
    });
    return Effect.gen(function* () {
      yield* resolveIdentity(dir);
      const config = readConfig(dir);
      expect(config.session_last_active).toBeGreaterThanOrEqual(before);
    }).pipe(
      Effect.provide(fsLayer),
      Effect.ensuring(Effect.sync(() => rmSync(dir, { recursive: true, force: true }))),
    );
  });
});
