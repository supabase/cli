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
import { legacyStop } from "./stop.handler.ts";
import type { LegacyStopFlags } from "./stop.command.ts";

const tempRoot = useLegacyTempWorkdir("supabase-stop-int-");

function flags(overrides: Partial<LegacyStopFlags> = {}): LegacyStopFlags {
  return {
    projectId: Option.none(),
    backup: true,
    noBackup: false,
    all: false,
    ...overrides,
  };
}

function writeConfig(workdir: string, projectId: string) {
  const supabaseDir = join(workdir, "supabase");
  mkdirSync(supabaseDir, { recursive: true });
  writeFileSync(join(supabaseDir, "config.toml"), `project_id = "${projectId}"\n`);
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

/**
 * Routes each spawned invocation to a caller-supplied result by matching argv
 * (rather than a fixed call sequence): `stop` issues five distinct docker
 * subcommands (`ps`, `stop`, `container prune`, `volume prune`, `network prune`,
 * `volume ls`) whose relative order/count varies per scenario (N `stop` calls for
 * N listed containers), so a routing table is a better fit than the sequential
 * step-array mock `gen types` uses for its single linear pipeline.
 */
function mockRoutedContainerCliSpawner(
  route: (args: ReadonlyArray<string>) => RouteResult,
  opts: {
    readonly dockerMissing?: boolean;
    // Fails BOTH docker and podman spawn attempts for argv matching this predicate,
    // simulating a runtime that cannot be spawned at all (as opposed to a spawned
    // process exiting non-zero) — exercises the `Effect.mapError`/`orElseSucceed`
    // spawn-failure branches distinct from the exit-code-checking branches.
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
          pid: ChildProcessSpawner.ProcessId(4000 + spawned.length),
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

/** Default happy-path router: `ps` lists one container, everything else succeeds empty. */
function defaultRoute(
  opts: {
    readonly containerIds?: ReadonlyArray<string>;
    readonly volumeNames?: ReadonlyArray<string>;
  } = {},
) {
  const containerIds = opts.containerIds ?? ["c1"];
  const volumeNames = opts.volumeNames ?? [];
  return (args: ReadonlyArray<string>): RouteResult => {
    if (args[0] === "ps") return { stdout: containerIds };
    if (args[0] === "volume" && args[1] === "ls") return { stdout: volumeNames };
    return { exitCode: 0 };
  };
}

interface SetupOpts {
  readonly format?: "text" | "json" | "stream-json";
  readonly route?: (args: ReadonlyArray<string>) => RouteResult;
  readonly dockerMissing?: boolean;
  readonly failSpawnFor?: (args: ReadonlyArray<string>) => boolean;
  readonly configuredProjectId?: string;
  readonly skipConfig?: boolean;
}

function setup(opts: SetupOpts = {}) {
  const workdir = tempRoot.current;
  if (opts.skipConfig !== true) {
    writeConfig(workdir, opts.configuredProjectId ?? "demo");
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
  );

  return { workdir, out, telemetry, child, layer };
}

describe("legacy stop integration", () => {
  it.live(
    "stops the current project's containers with backup and suggests the volume command",
    () => {
      const { layer, out, child } = setup({
        configuredProjectId: "demo",
        route: defaultRoute({ containerIds: ["c1", "c2"], volumeNames: ["supabase_db_demo"] }),
      });
      return Effect.gen(function* () {
        yield* legacyStop(flags());
        const psCall = child.spawned.find((s) => s.args[0] === "ps");
        expect(psCall?.args).toEqual([
          "ps",
          "--filter",
          "label=com.supabase.cli.project=demo",
          "--all",
          "--format",
          "{{.ID}}",
        ]);
        const stopCalls = child.spawned.filter((s) => s.args[0] === "stop");
        expect(stopCalls.map((s) => s.args)).toEqual([
          ["stop", "c1"],
          ["stop", "c2"],
        ]);
        expect(out.stdoutText).toContain("Stopped");
        expect(out.stdoutText).toContain("local development setup.");
        expect(out.stderrText).toContain(
          "Local data are backed up to docker volume. Use docker to show them:",
        );
        expect(out.stderrText).toContain(
          "docker volume ls --filter label=com.supabase.cli.project=demo",
        );
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "sanitizes a dirty config.toml project_id before filtering, matching start's label",
    () => {
      // Go's Config.Validate rewrites Config.ProjectId to its sanitized form once
      // at config-load time (pkg/config/config.go:938-944); every later reader —
      // including the Docker label `start` writes — sees that same sanitized
      // string. Filtering on the raw value here would match nothing `start`
      // ever labeled.
      const { layer, child } = setup({
        configuredProjectId: "My App!!",
        route: defaultRoute(),
      });
      return Effect.gen(function* () {
        yield* legacyStop(flags());
        const psCall = child.spawned.find((s) => s.args[0] === "ps");
        expect(psCall?.args).toEqual([
          "ps",
          "--filter",
          "label=com.supabase.cli.project=My_App_",
          "--all",
          "--format",
          "{{.ID}}",
        ]);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("keeps an explicit --project-id raw, unsanitized (Go's bypass)", () => {
    // Go assigns the --project-id flag value straight to Config.ProjectId
    // without going through Validate (internal/stop/stop.go:19-20), so this
    // path must NOT sanitize even though the default (config-derived) path does.
    const { layer, child } = setup({ skipConfig: true, route: defaultRoute() });
    return Effect.gen(function* () {
      yield* legacyStop(flags({ projectId: Option.some("Raw Value!!") }));
      const psCall = child.spawned.find((s) => s.args[0] === "ps");
      expect(psCall?.args).toEqual([
        "ps",
        "--filter",
        "label=com.supabase.cli.project=Raw Value!!",
        "--all",
        "--format",
        "{{.ID}}",
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.live("stops every project's containers with --all without reading config.toml", () => {
    const { layer, child } = setup({ skipConfig: true, route: defaultRoute() });
    return Effect.gen(function* () {
      yield* legacyStop(flags({ all: true }));
      const psCall = child.spawned.find((s) => s.args[0] === "ps");
      expect(psCall?.args).toEqual([
        "ps",
        "--filter",
        "label=com.supabase.cli.project",
        "--all",
        "--format",
        "{{.ID}}",
      ]);
      const pruneCalls = child.spawned.filter(
        (s) => s.args[0] === "container" && s.args[1] === "prune",
      );
      expect(pruneCalls[0]?.args).toEqual([
        "container",
        "prune",
        "--force",
        "--filter",
        "label=com.supabase.cli.project",
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.live("suggests the bare-label volume command with --all when volumes remain", () => {
    const { layer, out } = setup({
      skipConfig: true,
      route: defaultRoute({ volumeNames: ["supabase_db_demo"] }),
    });
    return Effect.gen(function* () {
      yield* legacyStop(flags({ all: true }));
      expect(out.stderrText).toContain(
        "Local data are backed up to docker volume. Use docker to show them:",
      );
      expect(out.stderrText).toContain("docker volume ls --filter label=com.supabase.cli.project");
      expect(out.stderrText).not.toContain("com.supabase.cli.project=");
    }).pipe(Effect.provide(layer));
  });

  it.live("stops a named project with --project-id without reading config.toml", () => {
    const { layer, child } = setup({ skipConfig: true, route: defaultRoute() });
    return Effect.gen(function* () {
      yield* legacyStop(flags({ projectId: Option.some("other-project") }));
      const psCall = child.spawned.find((s) => s.args[0] === "ps");
      expect(psCall?.args).toEqual([
        "ps",
        "--filter",
        "label=com.supabase.cli.project=other-project",
        "--all",
        "--format",
        "{{.ID}}",
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.live("rejects --project-id together with --all", () => {
    const { layer, child } = setup({ skipConfig: true, route: defaultRoute() });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacyStop(flags({ projectId: Option.some("other-project"), all: true })),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("LegacyStopMutuallyExclusiveError");
      }
      expect(child.spawned).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.live("deletes data volumes with --no-backup", () => {
    const { layer, child } = setup({ configuredProjectId: "demo", route: defaultRoute() });
    return Effect.gen(function* () {
      yield* legacyStop(flags({ noBackup: true }));
      const volumePrune = child.spawned.find(
        (s) => s.args[0] === "volume" && s.args[1] === "prune",
      );
      expect(volumePrune?.args).toEqual([
        "volume",
        "prune",
        "--force",
        "--all",
        "--filter",
        "label=com.supabase.cli.project=demo",
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.live("--backup=false alone does not delete data volumes, matching Go's dead flag", () => {
    // Go's `--backup` is declared but never bound to a variable (`cmd/stop.go:26`) —
    // `RunE` always passes `!noBackup`, so `--backup=false` has zero effect in the
    // real Go binary today. Only `--no-backup` deletes volumes.
    const { layer, child } = setup({ configuredProjectId: "demo", route: defaultRoute() });
    return Effect.gen(function* () {
      yield* legacyStop(flags({ backup: false }));
      const volumePrune = child.spawned.find(
        (s) => s.args[0] === "volume" && s.args[1] === "prune",
      );
      expect(volumePrune).toBeUndefined();
    }).pipe(Effect.provide(layer));
  });

  it.live("--no-backup still deletes data volumes even when --backup stays true", () => {
    const { layer, child } = setup({ configuredProjectId: "demo", route: defaultRoute() });
    return Effect.gen(function* () {
      yield* legacyStop(flags({ backup: true, noBackup: true }));
      const volumePrune = child.spawned.find(
        (s) => s.args[0] === "volume" && s.args[1] === "prune",
      );
      expect(volumePrune?.args).toEqual([
        "volume",
        "prune",
        "--force",
        "--all",
        "--filter",
        "label=com.supabase.cli.project=demo",
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.live("keeps data volumes by default (no volume prune call)", () => {
    const { layer, child } = setup({ configuredProjectId: "demo", route: defaultRoute() });
    return Effect.gen(function* () {
      yield* legacyStop(flags());
      const volumePrune = child.spawned.find(
        (s) => s.args[0] === "volume" && s.args[1] === "prune",
      );
      expect(volumePrune).toBeUndefined();
    }).pipe(Effect.provide(layer));
  });

  it.live("fails when config.toml is malformed", () => {
    const workdir = tempRoot.current;
    mkdirSync(join(workdir, "supabase"), { recursive: true });
    writeFileSync(join(workdir, "supabase", "config.toml"), "not valid toml =====");
    const { layer, child } = setup({ skipConfig: true, route: defaultRoute() });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyStop(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("LegacyStopConfigLoadError");
      }
      expect(child.spawned).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.live("fails when stopping a container errors", () => {
    const { layer } = setup({
      configuredProjectId: "demo",
      route: (args) => {
        if (args[0] === "ps") return { stdout: ["c1"] };
        if (args[0] === "stop") return { exitCode: 1, stderr: ["boom"] };
        return { exitCode: 0 };
      },
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyStop(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("LegacyStopContainerError");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("fails when a container cannot be spawned to stop it at all", () => {
    // Distinct from a spawned `docker stop` exiting non-zero (covered above) —
    // this exercises the branch where docker AND podman both fail to spawn for
    // the `stop <id>` argv specifically.
    const { layer } = setup({
      configuredProjectId: "demo",
      route: (args) => (args[0] === "ps" ? { stdout: ["c1"] } : { exitCode: 0 }),
      failSpawnFor: (args) => args[0] === "stop",
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyStop(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("LegacyStopContainerError");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("fails cleanly in json mode without a text-mode spinner to dismiss", () => {
    // No `output.task` handle exists outside text mode — this exercises that
    // the failure path's `stopping?.fail() ?? Effect.void` no-ops correctly.
    const { layer } = setup({
      format: "json",
      configuredProjectId: "demo",
      route: (args) => {
        if (args[0] === "ps") return { stdout: ["c1"] };
        if (args[0] === "stop") return { exitCode: 1, stderr: ["boom"] };
        return { exitCode: 0 };
      },
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyStop(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("LegacyStopContainerError");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("fails when container prune errors", () => {
    const { layer } = setup({
      configuredProjectId: "demo",
      route: (args) => {
        if (args[0] === "container" && args[1] === "prune") return { exitCode: 1 };
        return defaultRoute()(args);
      },
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyStop(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("LegacyStopContainerPruneError");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("fails when volume prune errors", () => {
    const { layer } = setup({
      configuredProjectId: "demo",
      route: (args) => {
        if (args[0] === "volume" && args[1] === "prune") return { exitCode: 1 };
        return defaultRoute()(args);
      },
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyStop(flags({ noBackup: true })));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("LegacyStopVolumePruneError");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("fails when network prune errors", () => {
    const { layer } = setup({
      configuredProjectId: "demo",
      route: (args) => {
        if (args[0] === "network" && args[1] === "prune") return { exitCode: 1 };
        return defaultRoute()(args);
      },
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyStop(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("LegacyStopNetworkPruneError");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("fails when the container list errors", () => {
    const { layer } = setup({
      configuredProjectId: "demo",
      route: (args) => {
        if (args[0] === "ps") return { exitCode: 1, stderr: ["daemon down"] };
        return { exitCode: 0 };
      },
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyStop(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("LegacyStopListError");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("falls back to podman when docker is absent", () => {
    const { layer, child } = setup({
      configuredProjectId: "demo",
      route: defaultRoute(),
      dockerMissing: true,
    });
    return Effect.gen(function* () {
      yield* legacyStop(flags());
      // The failed `docker` attempt is recorded before the `podman` fallback fires
      // (`spawnContainerCli`'s `Effect.catch` retries the same argv), so the
      // successful call is the LAST matching record, not the first.
      const psCalls = child.spawned.filter((s) => s.args[0] === "ps");
      expect(psCalls.at(-1)?.command).toBe("podman");
      expect(psCalls.some((s) => s.command === "docker")).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("emits a machine result in json mode without spinner text", () => {
    const { layer, out } = setup({
      format: "json",
      configuredProjectId: "demo",
      route: defaultRoute({ volumeNames: ["supabase_db_demo"] }),
    });
    return Effect.gen(function* () {
      yield* legacyStop(flags());
      const success = out.messages.find((m) => m.type === "success");
      expect(success?.data).toMatchObject({ project_id_filter: "demo", backup: true });
      expect(out.stdoutText).not.toContain("\x1b[?25l");
      // json mode has no volume-suggestion equivalent — only text mode emits it.
      expect(out.stderrText).not.toContain("Local data are backed up");
    }).pipe(Effect.provide(layer));
  });

  it.live("shows no volume suggestion when no volumes remain", () => {
    const { layer, out } = setup({
      configuredProjectId: "demo",
      route: defaultRoute({ volumeNames: [] }),
    });
    return Effect.gen(function* () {
      yield* legacyStop(flags());
      expect(out.stderrText).not.toContain("Local data are backed up");
    }).pipe(Effect.provide(layer));
  });

  it.live("flushes telemetry via ensuring even on failure", () => {
    const { layer, telemetry } = setup({
      configuredProjectId: "demo",
      route: (args) => (args[0] === "ps" ? { exitCode: 1 } : { exitCode: 0 }),
    });
    return Effect.gen(function* () {
      yield* Effect.exit(legacyStop(flags()));
      expect(telemetry.flushed).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("fails when container prune cannot spawn any container runtime", () => {
    const { layer } = setup({
      configuredProjectId: "demo",
      route: defaultRoute(),
      failSpawnFor: (args) => args[0] === "container" && args[1] === "prune",
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyStop(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("LegacyStopContainerPruneError");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("fails when volume prune cannot spawn any container runtime", () => {
    const { layer } = setup({
      configuredProjectId: "demo",
      route: defaultRoute(),
      failSpawnFor: (args) => args[0] === "volume" && args[1] === "prune",
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyStop(flags({ noBackup: true })));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("LegacyStopVolumePruneError");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("fails when network prune cannot spawn any container runtime", () => {
    const { layer } = setup({
      configuredProjectId: "demo",
      route: defaultRoute(),
      failSpawnFor: (args) => args[0] === "network" && args[1] === "prune",
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyStop(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("LegacyStopNetworkPruneError");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("still reports success when the post-run volume listing fails", () => {
    // The volume-suggestion check is best-effort (`Effect.orElseSucceed`): a
    // failure listing volumes after a successful stop must not fail the command,
    // matching Go's `if resp, err := ...; err == nil && ...` (stop.go:29) — a
    // listing error there is silently ignored, not surfaced.
    const { layer, out } = setup({
      configuredProjectId: "demo",
      route: defaultRoute(),
      failSpawnFor: (args) => args[0] === "volume" && args[1] === "ls",
    });
    return Effect.gen(function* () {
      yield* legacyStop(flags());
      expect(out.stdoutText).toContain("Stopped");
      expect(out.stderrText).not.toContain("Local data are backed up");
    }).pipe(Effect.provide(layer));
  });
});
