import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Layer, Option } from "effect";

import { mockOutput, mockRuntimeInfo } from "../../../../../tests/helpers/mocks.ts";
import {
  mockLegacyCliConfig,
  mockLegacyTelemetryStateTracked,
  useLegacyTempWorkdir,
} from "../../../../../tests/helpers/legacy-mocks.ts";
import type { OutputFormat } from "../../../../shared/output/types.ts";
import { LegacyDbBootstrapError } from "../shared/legacy-db-bootstrap.errors.ts";
import { LegacyDbBootstrapSeam } from "../shared/legacy-db-bootstrap.seam.service.ts";
import { legacyDbStart } from "./start.handler.ts";
import type { LegacyDbStartFlags } from "./start.command.ts";

const DEFAULT_FLAGS: LegacyDbStartFlags = { fromBackup: Option.none() };

/**
 * Stateful mock of the container-bootstrap seam. `running` drives
 * `AssertSupabaseDbIsRunning`; `runningFails` / `startFails` make the respective
 * call fail (Docker daemon down / StartDatabase error). Records the args passed to
 * `startDatabase`.
 */
function mockSeam(opts: { running?: boolean; runningFails?: boolean; startFails?: boolean } = {}) {
  const startCalls: Array<{ fromBackup?: string }> = [];
  const layer = Layer.succeed(LegacyDbBootstrapSeam, {
    isDbRunning: () =>
      opts.runningFails === true
        ? Effect.fail(new LegacyDbBootstrapError({ message: "failed to inspect service" }))
        : Effect.succeed(opts.running ?? false),
    startDatabase: (args: { fromBackup?: string }) =>
      opts.startFails === true
        ? Effect.fail(new LegacyDbBootstrapError({ message: "failed to bootstrap" }))
        : Effect.sync(() => {
            startCalls.push(args);
          }),
    recreateDatabase: () => Effect.void,
    awaitStorageReady: () => Effect.succeed(false),
  });
  return {
    layer,
    get startCalls() {
      return startCalls;
    },
  };
}

function setup(
  workdir: string,
  opts: {
    toml?: string;
    format?: OutputFormat;
    running?: boolean;
    runningFails?: boolean;
    startFails?: boolean;
    /** Caller cwd (Go's `CurrentDirAbs`) for relative `--from-backup` resolution. */
    cwd?: string;
  },
) {
  if (opts.toml !== undefined) {
    mkdirSync(join(workdir, "supabase"), { recursive: true });
    writeFileSync(join(workdir, "supabase", "config.toml"), opts.toml);
  }
  const out = mockOutput({ format: opts.format ?? "text" });
  const seam = mockSeam(opts);
  const telemetry = mockLegacyTelemetryStateTracked();
  const layer = Layer.mergeAll(
    out.layer,
    seam.layer,
    mockLegacyCliConfig({ workdir }),
    telemetry.layer,
    mockRuntimeInfo({ cwd: opts.cwd ?? workdir }),
    BunServices.layer,
  );
  return { layer, out, seam, telemetry };
}

describe("legacy db start", () => {
  const tmp = useLegacyTempWorkdir("supabase-db-start-");

  it.live("reports an already-running database without starting a container", () => {
    const { layer, out, seam, telemetry } = setup(tmp.current, {
      toml: 'project_id = "test"\n',
      running: true,
    });
    return Effect.gen(function* () {
      yield* legacyDbStart(DEFAULT_FLAGS).pipe(Effect.provide(layer));
      expect(out.stderrText).toContain("Postgres database is already running.");
      expect(seam.startCalls).toHaveLength(0);
      expect(telemetry.flushed).toBe(true);
    });
  });

  it.live("starts the database when it is not running", () => {
    const { layer, out, seam } = setup(tmp.current, {
      toml: 'project_id = "test"\n',
      running: false,
    });
    return Effect.gen(function* () {
      yield* legacyDbStart(DEFAULT_FLAGS).pipe(Effect.provide(layer));
      expect(seam.startCalls).toEqual([{ fromBackup: undefined }]);
      // db start prints no "Finished" line and no status table.
      expect(out.stderrText).not.toContain("Finished");
    });
  });

  it.live("forwards an absolute --from-backup to the bootstrap seam unchanged", () => {
    const { layer, seam } = setup(tmp.current, { toml: 'project_id = "test"\n' });
    return Effect.gen(function* () {
      yield* legacyDbStart({ fromBackup: Option.some("/tmp/dump.sql") }).pipe(
        Effect.provide(layer),
      );
      expect(seam.startCalls).toEqual([{ fromBackup: "/tmp/dump.sql" }]);
    });
  });

  it.live("resolves a relative --from-backup against the caller cwd, not the workdir", () => {
    // Go resolves a relative fromBackup against `CurrentDirAbs` (the caller cwd, captured
    // before ChangeWorkDir), so the seam must receive the caller-relative absolute path even
    // though its Go child runs with cwd = the project workdir.
    const { layer, seam } = setup(tmp.current, {
      toml: 'project_id = "test"\n',
      cwd: "/caller/here",
    });
    return Effect.gen(function* () {
      yield* legacyDbStart({ fromBackup: Option.some("dump.sql") }).pipe(Effect.provide(layer));
      expect(seam.startCalls).toEqual([{ fromBackup: "/caller/here/dump.sql" }]);
    });
  });

  it.live("treats an empty --from-backup as a normal no-backup start", () => {
    // Go's StartDatabase sees `len(fromBackup) == 0` and starts without a backup; an empty
    // string must not be joined to the caller cwd and passed as a directory path.
    const { layer, seam } = setup(tmp.current, {
      toml: 'project_id = "test"\n',
      cwd: "/caller/here",
    });
    return Effect.gen(function* () {
      yield* legacyDbStart({ fromBackup: Option.some("") }).pipe(Effect.provide(layer));
      expect(seam.startCalls).toEqual([{ fromBackup: undefined }]);
    });
  });

  it.live("proceeds with no config file (missing config is tolerated)", () => {
    const { layer, seam } = setup(tmp.current, { running: false });
    return Effect.gen(function* () {
      yield* legacyDbStart(DEFAULT_FLAGS).pipe(Effect.provide(layer));
      expect(seam.startCalls).toHaveLength(1);
    });
  });

  it.live("fails fast on a malformed config.toml", () => {
    const { layer, seam, telemetry } = setup(tmp.current, {
      toml: 'project_id = "unterminated\n',
    });
    return Effect.gen(function* () {
      const exit = yield* legacyDbStart(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("failed to load config");
      }
      // No container work attempted; telemetry still flushes on failure.
      expect(seam.startCalls).toHaveLength(0);
      expect(telemetry.flushed).toBe(true);
    });
  });

  it.live("fails fast on an undecryptable secret even when the db is already running", () => {
    // Regression for the seam swallowing config-load errors: Go runs `flags.LoadConfig`
    // (which decrypts every secret) BEFORE `AssertSupabaseDbIsRunning`, so a broken
    // config aborts `db start` regardless of container state. Previously the handler's
    // only config read was the seam's best-effort one, so an undecryptable secret with
    // the container already up printed "already running" and exited 0.
    const { layer, out } = setup(tmp.current, {
      toml: '[db]\nroot_key = "encrypted:anything"\n',
      running: true,
    });
    return Effect.gen(function* () {
      const exit = yield* legacyDbStart(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("failed to parse config: missing private key");
      }
      expect(out.stderrText).not.toContain("already running");
    });
  });

  it.live("propagates a Docker inspect failure", () => {
    const { layer } = setup(tmp.current, { toml: 'project_id = "test"\n', runningFails: true });
    return Effect.gen(function* () {
      const exit = yield* legacyDbStart(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("failed to inspect service");
      }
    });
  });

  it.live("propagates a StartDatabase failure", () => {
    const { layer } = setup(tmp.current, { toml: 'project_id = "test"\n', startFails: true });
    return Effect.gen(function* () {
      const exit = yield* legacyDbStart(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("failed to bootstrap");
      }
    });
  });

  it.live("emits a json result when the database is already running", () => {
    const { layer, out } = setup(tmp.current, {
      toml: 'project_id = "test"\n',
      running: true,
      format: "json",
    });
    return Effect.gen(function* () {
      yield* legacyDbStart(DEFAULT_FLAGS).pipe(Effect.provide(layer));
      const success = out.messages.find((m) => m.type === "success");
      expect(success?.data?.["status"]).toBe("already-running");
    });
  });

  it.live("emits a json result after starting the database", () => {
    const { layer, out, seam } = setup(tmp.current, {
      toml: 'project_id = "test"\n',
      running: false,
      format: "json",
    });
    return Effect.gen(function* () {
      yield* legacyDbStart(DEFAULT_FLAGS).pipe(Effect.provide(layer));
      expect(seam.startCalls).toHaveLength(1);
      const success = out.messages.find((m) => m.type === "success");
      expect(success?.data?.["status"]).toBe("started");
    });
  });
});
