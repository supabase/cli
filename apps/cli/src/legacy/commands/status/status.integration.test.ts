import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Exit, Layer, Option, PlatformError, Sink, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import { mockOutput } from "../../../../tests/helpers/mocks.ts";
import {
  mockLegacyCliConfig,
  mockLegacyTelemetryStateTracked,
  useLegacyTempWorkdir,
} from "../../../../tests/helpers/legacy-mocks.ts";
import { LegacyOutputFlag } from "../../../shared/legacy/global-flags.ts";
import { legacyServiceContainerIds, localDbContainerId } from "../../shared/legacy-docker-ids.ts";
import type { LegacyStatusFlags } from "./status.command.ts";
import { legacyStatus } from "./status.handler.ts";

const tempRoot = useLegacyTempWorkdir("supabase-status-int-");

function flags(overrides: Partial<LegacyStatusFlags> = {}): LegacyStatusFlags {
  return {
    overrideName: [],
    exclude: [],
    ignoreHealthCheck: false,
    ...overrides,
  };
}

function writeConfig(workdir: string, contents = 'project_id = "demo"\n') {
  const supabaseDir = join(workdir, "supabase");
  mkdirSync(supabaseDir, { recursive: true });
  writeFileSync(join(supabaseDir, "config.toml"), contents);
}

interface SpawnRecord {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

type RouteResult = {
  readonly exitCode?: number;
  readonly stdout?: ReadonlyArray<string>;
  readonly stderr?: ReadonlyArray<string>;
};

/** Same routing-by-argv mock spawner shape as `stop.integration.test.ts`. */
function mockRoutedContainerCliSpawner(
  route: (args: ReadonlyArray<string>) => RouteResult,
  opts: {
    readonly dockerMissing?: boolean;
    readonly failSpawnFor?: (args: ReadonlyArray<string>) => boolean;
  } = {},
) {
  const spawned: Array<SpawnRecord> = [];

  const layer = Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) =>
      Effect.gen(function* () {
        const cmd = command._tag === "StandardCommand" ? command.command : "";
        const args = command._tag === "StandardCommand" ? command.args : [];
        spawned.push({ command: cmd, args });

        if (opts.dockerMissing === true && cmd === "docker") {
          return yield* Effect.fail(
            PlatformError.systemError({
              _tag: "NotFound",
              module: "ChildProcess",
              method: "spawn",
              description: "docker not found",
            }),
          );
        }

        if (opts.failSpawnFor?.(args) === true) {
          return yield* Effect.fail(
            PlatformError.systemError({
              _tag: "NotFound",
              module: "ChildProcess",
              method: "spawn",
              description: "spawn failed",
            }),
          );
        }

        const encoder = new TextEncoder();
        const result = route(args);
        const exitDeferred = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
        yield* Effect.forkDetach(
          Effect.gen(function* () {
            yield* Effect.sleep("5 millis");
            yield* Deferred.succeed(
              exitDeferred,
              ChildProcessSpawner.ExitCode(result.exitCode ?? 0),
            );
          }),
        );
        const stdoutBytes = (result.stdout ?? []).map((line) => encoder.encode(`${line}\n`));
        const stderrBytes = (result.stderr ?? []).map((line) => encoder.encode(`${line}\n`));

        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(5000 + spawned.length),
          stdout: Stream.fromIterable(stdoutBytes),
          stderr: Stream.fromIterable(stderrBytes),
          all: Stream.empty,
          exitCode: Deferred.await(exitDeferred),
          isRunning: Effect.succeed(false),
          stdin: Sink.drain,
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        });
      }),
    ),
  );

  return {
    layer,
    get spawned() {
      return spawned;
    },
  };
}

const ALL_RUNNING_NAMES = legacyServiceContainerIds("demo");
const HEALTHY_DB_STATE = JSON.stringify({ Status: "running", Health: { Status: "healthy" } });

/**
 * Default happy-path router: db container inspect reports healthy+running, `ps`
 * (names format) lists every one of the 13 expected services as running.
 */
function defaultRoute(
  opts: {
    readonly runningNames?: ReadonlyArray<string>;
    readonly dbInspectStdout?: string;
    readonly dbInspectExitCode?: number;
    readonly dbInspectStderr?: ReadonlyArray<string>;
  } = {},
) {
  const runningNames = opts.runningNames ?? ALL_RUNNING_NAMES;
  return (args: ReadonlyArray<string>): RouteResult => {
    if (args[0] === "container" && args[1] === "inspect") {
      return {
        exitCode: opts.dbInspectExitCode ?? 0,
        stdout: [opts.dbInspectStdout ?? HEALTHY_DB_STATE],
        stderr: opts.dbInspectStderr,
      };
    }
    if (args[0] === "ps") return { stdout: runningNames };
    return { exitCode: 0 };
  };
}

interface SetupOpts {
  readonly format?: "text" | "json" | "stream-json";
  readonly goOutput?: Option.Option<"env" | "pretty" | "json" | "toml" | "yaml">;
  readonly route?: (args: ReadonlyArray<string>) => RouteResult;
  readonly dockerMissing?: boolean;
  readonly failSpawnFor?: (args: ReadonlyArray<string>) => boolean;
  readonly skipConfig?: boolean;
  readonly configContents?: string;
}

function setup(opts: SetupOpts = {}) {
  const workdir = tempRoot.current;
  if (opts.skipConfig !== true) {
    writeConfig(workdir, opts.configContents);
  }
  const out = mockOutput({
    format: opts.format ?? "text",
    interactive: (opts.format ?? "text") === "text",
  });
  const telemetry = mockLegacyTelemetryStateTracked();
  const cliConfig = mockLegacyCliConfig({ workdir, projectId: Option.none() });
  const child = mockRoutedContainerCliSpawner(opts.route ?? defaultRoute(), {
    dockerMissing: opts.dockerMissing,
    failSpawnFor: opts.failSpawnFor,
  });

  const layer = Layer.mergeAll(
    BunServices.layer,
    out.layer,
    cliConfig,
    telemetry.layer,
    child.layer,
    Layer.succeed(LegacyOutputFlag, opts.goOutput ?? Option.none()),
  );

  return { workdir, out, telemetry, child, layer };
}

describe("legacy status integration", () => {
  it.live("shows the running stack as a pretty table", () => {
    const { layer, out } = setup();
    return Effect.gen(function* () {
      yield* legacyStatus(flags());
      expect(out.stderrText).toContain("local development setup is running.");
      expect(out.stdoutText).toContain("🔧 Development Tools");
      expect(out.stdoutText).toContain("🌐 APIs");
      expect(out.stdoutText).toContain("⛁ Database");
      expect(out.stdoutText).toContain("🔑 Authentication Keys");
      expect(out.stdoutText).toContain("📦 Storage (S3)");
      expect(out.stdoutText).toContain("postgresql://postgres:postgres@");
      expect(out.stderrText).not.toContain("Stopped services:");
    }).pipe(Effect.provide(layer));
  });

  it.live("skips the db health check with --ignore-health-check", () => {
    const { layer, child } = setup({
      route: (args) => {
        // db inspect would fail if called; ps still needs to succeed.
        if (args[0] === "container" && args[1] === "inspect") return { exitCode: 1 };
        if (args[0] === "ps") return { stdout: ALL_RUNNING_NAMES };
        return { exitCode: 0 };
      },
    });
    return Effect.gen(function* () {
      yield* legacyStatus(flags({ ignoreHealthCheck: true }));
      expect(child.spawned.some((s) => s.args[0] === "container" && s.args[1] === "inspect")).toBe(
        false,
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("reports stopped services on stderr", () => {
    const { layer, out } = setup({
      route: defaultRoute({ runningNames: ALL_RUNNING_NAMES.slice(1) }),
    });
    return Effect.gen(function* () {
      yield* legacyStatus(flags());
      const missing = ALL_RUNNING_NAMES[0];
      expect(out.stderrText).toContain(`Stopped services: [${missing}]`);
    }).pipe(Effect.provide(layer));
  });

  it.live("fails when config.toml is malformed", () => {
    const workdir = tempRoot.current;
    mkdirSync(join(workdir, "supabase"), { recursive: true });
    writeFileSync(join(workdir, "supabase", "config.toml"), "not valid toml =====");
    const { layer, child } = setup({ skipConfig: true });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyStatus(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("LegacyStatusConfigLoadError");
      }
      expect(child.spawned).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.live("fails when config.toml is missing entirely", () => {
    const { layer } = setup({ skipConfig: true });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyStatus(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("LegacyStatusConfigLoadError");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("fails when both docker and podman are missing", () => {
    // Neither container runtime can be spawned at all — distinct from a spawned
    // process exiting non-zero (covered by the malformed/unhealthy scenarios
    // above).
    const { layer } = setup({ failSpawnFor: () => true });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyStatus(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("LegacyStatusDbInspectError");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("falls back to podman when docker is absent", () => {
    const { layer, child } = setup({ dockerMissing: true });
    return Effect.gen(function* () {
      yield* legacyStatus(flags());
      // The failed `docker` attempt is recorded before the `podman` fallback fires
      // (`spawnContainerCli`'s `Effect.catch` retries the same argv), so the last
      // matching record for a given argv is the successful one.
      const psCalls = child.spawned.filter((s) => s.args[0] === "ps");
      expect(psCalls.at(-1)?.command).toBe("podman");
      expect(psCalls.some((s) => s.command === "docker")).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("fails when listing running containers errors", () => {
    const { layer } = setup({
      route: (args) => {
        if (args[0] === "container" && args[1] === "inspect") {
          return { exitCode: 0, stdout: [HEALTHY_DB_STATE] };
        }
        if (args[0] === "ps") return { exitCode: 1, stderr: ["daemon down"] };
        return { exitCode: 0 };
      },
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyStatus(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("LegacyStatusListError");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("fails when the db container is not running", () => {
    const { layer } = setup({
      route: defaultRoute({ dbInspectStdout: JSON.stringify({ Status: "exited" }) }),
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyStatus(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const serialized = JSON.stringify(exit.cause);
        expect(serialized).toContain("LegacyStatusDbNotRunningError");
        expect(serialized).toContain(localDbContainerId("demo"));
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("fails when the db container is absent", () => {
    const { layer } = setup({
      route: defaultRoute({
        dbInspectExitCode: 1,
        dbInspectStderr: ["Error: No such container: x"],
      }),
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyStatus(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("LegacyStatusDbInspectError");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("fails when the db container is unhealthy", () => {
    const { layer } = setup({
      route: defaultRoute({
        dbInspectStdout: JSON.stringify({ Status: "running", Health: { Status: "starting" } }),
      }),
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyStatus(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("LegacyStatusDbNotReadyError");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("fails when db inspect errors for a reason other than not-found", () => {
    const { layer } = setup({
      route: defaultRoute({ dbInspectExitCode: 1, dbInspectStderr: ["permission denied"] }),
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyStatus(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("LegacyStatusDbInspectError");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("outputs env vars with -o env", () => {
    const { layer, out } = setup({ goOutput: Option.some("env") });
    return Effect.gen(function* () {
      yield* legacyStatus(flags());
      expect(out.stdoutText).toContain('API_URL="http://127.0.0.1:54321"');
      expect(out.stdoutText).toContain("DB_URL=");
    }).pipe(Effect.provide(layer));
  });

  it.live("outputs a json object with -o json", () => {
    const { layer, out } = setup({ goOutput: Option.some("json") });
    return Effect.gen(function* () {
      yield* legacyStatus(flags());
      const parsed = JSON.parse(out.stdoutText) as Record<string, string>;
      expect(parsed.API_URL).toBe("http://127.0.0.1:54321");
      expect(parsed.DB_URL).toContain("postgresql://postgres:postgres@");
    }).pipe(Effect.provide(layer));
  });

  it.live("omits excluded services from -o json", () => {
    const { layer, out } = setup({ goOutput: Option.some("json") });
    return Effect.gen(function* () {
      const storageId = legacyServiceContainerIds("demo")[5]!;
      yield* legacyStatus(flags({ exclude: [storageId] }));
      const parsed = JSON.parse(out.stdoutText) as Record<string, string>;
      expect(parsed.STORAGE_S3_URL).toBeUndefined();
      expect(parsed.API_URL).toBeDefined();
    }).pipe(Effect.provide(layer));
  });

  it.live("outputs yaml with -o yaml", () => {
    const { layer, out } = setup({ goOutput: Option.some("yaml") });
    return Effect.gen(function* () {
      yield* legacyStatus(flags());
      expect(out.stdoutText).toContain("API_URL:");
    }).pipe(Effect.provide(layer));
  });

  it.live("outputs toml with -o toml", () => {
    const { layer, out } = setup({ goOutput: Option.some("toml") });
    return Effect.gen(function* () {
      yield* legacyStatus(flags());
      expect(out.stdoutText).toContain("API_URL =");
    }).pipe(Effect.provide(layer));
  });

  it.live("remaps an output key with --override-name api.url=NEXT_PUBLIC_SUPABASE_URL", () => {
    const { layer, out } = setup({ goOutput: Option.some("json") });
    return Effect.gen(function* () {
      yield* legacyStatus(flags({ overrideName: ["api.url=NEXT_PUBLIC_SUPABASE_URL"] }));
      const parsed = JSON.parse(out.stdoutText) as Record<string, string>;
      expect(parsed.NEXT_PUBLIC_SUPABASE_URL).toBe("http://127.0.0.1:54321");
      expect(parsed.API_URL).toBeUndefined();
    }).pipe(Effect.provide(layer));
  });

  it.live("fails on a malformed --override-name entry", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyStatus(flags({ overrideName: ["not-a-kv-pair"] })));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("LegacyStatusOverrideParseError");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("fails on an --override-name entry with an unknown field key", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacyStatus(flags({ overrideName: ["not.a.real.field=NAME"] })),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("LegacyStatusOverrideParseError");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("emits a machine result with --output-format json when -o is unset", () => {
    const { layer, out } = setup({ format: "json" });
    return Effect.gen(function* () {
      yield* legacyStatus(flags());
      const success = out.messages.find((m) => m.type === "success");
      expect(success?.data).toMatchObject({ API_URL: "http://127.0.0.1:54321" });
      expect(out.stdoutText).not.toContain("\x1b[?25l");
    }).pipe(Effect.provide(layer));
  });

  it.live("-o takes priority over --output-format when both are passed", () => {
    const { layer, out } = setup({ format: "json", goOutput: Option.some("env") });
    return Effect.gen(function* () {
      yield* legacyStatus(flags());
      // -o env wins: raw KEY="VALUE" text on stdout, not a structured success message.
      expect(out.stdoutText).toContain('API_URL="http://127.0.0.1:54321"');
      expect(out.messages.find((m) => m.type === "success")).toBeUndefined();
    }).pipe(Effect.provide(layer));
  });

  it.live("flushes telemetry via ensuring even on failure", () => {
    const { layer, telemetry } = setup({
      route: (args) =>
        args[0] === "container" && args[1] === "inspect" ? { exitCode: 1 } : { exitCode: 0 },
    });
    return Effect.gen(function* () {
      yield* Effect.exit(legacyStatus(flags()));
      expect(telemetry.flushed).toBe(true);
    }).pipe(Effect.provide(layer));
  });
});
