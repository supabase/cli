import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import {
  Cause,
  Deferred,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  PlatformError,
  Sink,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { vi } from "vitest";

import { mockOutput } from "../../../tests/helpers/mocks.ts";
import {
  mockCommandSettings,
  mockTelemetryStateTracked,
  useTempWorkdir,
  withEnvVar,
} from "../../../tests/helpers/command-mocks.ts";
import { DebugFlag } from "../../command-internal/global-flags.ts";
import { stop } from "./stop.handler.ts";
import type { StopFlags } from "./stop.command.ts";

const tempRoot = useTempWorkdir("supabase-stop-int-");

function flags(overrides: Partial<StopFlags> = {}): StopFlags {
  return {
    projectId: Option.none(),
    backup: true,
    noBackup: false,
    all: Option.none(),
    ...overrides,
  };
}

const writeFileIn = (dir: string, fileName: string, contents: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(dir, { recursive: true });
    yield* fs.writeFileString(path.join(dir, fileName), contents);
  });

const writeSupabaseFile = (workdir: string, fileName: string, contents: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    yield* writeFileIn(path.join(workdir, "supabase"), fileName, contents);
  });

const writeConfig = (workdir: string, projectId: string) =>
  writeSupabaseFile(workdir, "config.toml", `project_id = "${projectId}"\n`);

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
 * Routes each spawned invocation to a caller-supplied result by matching argv (rather than a
 * fixed call sequence): `stop` issues five distinct docker subcommands whose relative
 * order/count varies per scenario (N `stop` calls for N listed containers), so a routing table
 * fits better than a sequential step array.
 *
 * `stop`'s `ps` listing uses the combined `--format "{{.ID}}\t{{.Names}}\t{{.Label
 * \"com.supabase.cli.workdir\"}}"` so `cleanupStartSecrets` gets container names/workdirs from
 * the same request that lists ids to stop, without a second `docker ps` call. A `ps` route's
 * `stdout` is one `<id>\t<name>` line per container (no workdir column — every test here
 * exercises the `cliSettings.workdir` fallback); `defaultRoute` below tab-joins each id with itself.
 */
function mockRoutedContainerCliSpawner(
  route: (args: ReadonlyArray<string>) => RouteResult,
  opts: {
    readonly dockerMissing?: boolean;
    // Fails both docker and podman spawn attempts matching this predicate, simulating a
    // runtime that cannot be spawned at all (vs. a spawned process exiting non-zero).
    readonly failSpawnFor?: (args: ReadonlyArray<string>) => boolean;
  } = {},
) {
  const spawned: Array<SpawnRecord> = [];

  const layer = Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) =>
      Effect.gen(function* () {
        const standard = ChildProcess.isStandardCommand(command);
        const cmd = standard ? command.command : "";
        const args = standard ? command.args : [];
        spawned.push({ command: cmd, args });

        if (opts.dockerMissing === true && cmd === "docker") {
          return yield* PlatformError.systemError({
            _tag: "NotFound",
            module: "ChildProcess",
            method: "spawn",
            description: "docker not found",
          });
        }

        if (opts.failSpawnFor?.(args) === true) {
          return yield* PlatformError.systemError({
            _tag: "NotFound",
            module: "ChildProcess",
            method: "spawn",
            description: "spawn failed",
          });
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

/**
 * Default happy-path router: `ps` lists one container, `docker version` reports an API version
 * above the `volume prune --all` gate (see `dockerSupportsVolumePruneAllFlag`), everything else
 * succeeds empty.
 */
function defaultRoute(
  opts: {
    readonly containerIds?: ReadonlyArray<string>;
    readonly volumeNames?: ReadonlyArray<string>;
    readonly dockerApiVersion?: string;
  } = {},
) {
  const containerIds = opts.containerIds ?? ["c1"];
  const volumeNames = opts.volumeNames ?? [];
  const dockerApiVersion = opts.dockerApiVersion ?? "1.45";
  return (args: ReadonlyArray<string>): RouteResult => {
    if (args[0] === "ps") return { stdout: containerIds.map((id) => `${id}\t${id}`) };
    if (args[0] === "volume" && args[1] === "ls") return { stdout: volumeNames };
    if (args[0] === "version") return { stdout: [dockerApiVersion] };
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
  /** Defaults to `tempRoot.current` — override for `--workdir`-resolution tests. */
  readonly workdir?: string;
  /** `--debug` — gates `dockerRemoveAll`'s `Pruned …:` stderr reports. */
  readonly debug?: boolean;
}

const setup = (opts: SetupOpts = {}) =>
  Effect.gen(function* () {
    const workdir = opts.workdir ?? tempRoot.current;
    if (opts.skipConfig !== true) {
      yield* writeConfig(workdir, opts.configuredProjectId ?? "demo");
    }
    const out = mockOutput({
      format: opts.format ?? "text",
      interactive: (opts.format ?? "text") === "text",
    });
    const telemetry = mockTelemetryStateTracked();
    const cliSettings = mockCommandSettings({ workdir, projectId: Option.none() });
    const child = mockRoutedContainerCliSpawner(opts.route ?? defaultRoute(), {
      dockerMissing: opts.dockerMissing,
      failSpawnFor: opts.failSpawnFor,
    });

    const layer = Layer.mergeAll(
      BunServices.layer,
      out.layer,
      cliSettings,
      telemetry.layer,
      child.layer,
      Layer.succeed(DebugFlag, opts.debug ?? false),
    );

    return { workdir, out, telemetry, child, layer };
  });

describe("stop integration", () => {
  it.live(
    "stops the current project's containers with backup and suggests the volume command",
    () =>
      Effect.gen(function* () {
        const { layer, out, child } = yield* setup({
          configuredProjectId: "demo",
          route: defaultRoute({ containerIds: ["c1", "c2"], volumeNames: ["supabase_db_demo"] }),
        });
        yield* stop(flags()).pipe(Effect.provide(layer));
        const psCall = child.spawned.find((s) => s.args[0] === "ps");
        expect(psCall?.args).toEqual([
          "ps",
          "--filter",
          "label=com.supabase.cli.project=demo",
          "--all",
          "--format",
          '{{.ID}}\t{{.Names}}\t{{.Label "com.supabase.cli.workdir"}}',
        ]);
        const stopCalls = child.spawned.filter((s) => s.args[0] === "stop");
        expect(stopCalls.map((s) => s.args)).toEqual([
          ["stop", "c1"],
          ["stop", "c2"],
        ]);
        expect(out.stdoutText).toContain("Stopping containers...");
        expect(out.stdoutText).toContain("Stopped");
        expect(out.stdoutText).toContain("local development setup.");
        expect(out.stderrText).toContain(
          "Local data are backed up to docker volume. Use docker to show them:",
        );
        expect(out.stderrText).toContain(
          "docker volume ls --filter label=com.supabase.cli.project=demo",
        );
      }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live(
    "reclaims staged-secret directories for containers it tears down, leaving unrelated ones alone",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        // `defaultRoute`'s `ps` stdout has no workdir-label column, so this also exercises the
        // fallback to `cliSettings.workdir` for containers with no `com.supabase.cli.workdir` label.
        const { layer, workdir } = yield* setup({
          configuredProjectId: "demo",
          route: defaultRoute({ containerIds: ["supabase_kong_demo"] }),
        });
        const startSecretsDir = path.join(workdir, "supabase", ".temp", "start-secrets");
        const matchedDir = path.join(startSecretsDir, "supabase_kong_demo");
        const unmatchedDir = path.join(startSecretsDir, "supabase_kong_other-project");
        yield* writeFileIn(matchedDir, "secret-0", "kong.yml contents");
        yield* writeFileIn(unmatchedDir, "secret-0", "unrelated project's secret");
        yield* stop(flags()).pipe(Effect.provide(layer));
        expect(yield* fs.exists(matchedDir)).toBe(false);
        expect(yield* fs.exists(unmatchedDir)).toBe(true);
      }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live(
    "reclaims a container's staged-secret directory at its OWN labeled workdir, not this invocation's cwd",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        // Simulates `stop --all` tearing down a container from a different project than this
        // invocation's own cwd/`--workdir`.
        const workdir = tempRoot.current;
        const otherProjectWorkdir = path.join(workdir, "other-project-root");
        const { layer } = yield* setup({
          workdir,
          skipConfig: true,
          route: (args) => {
            if (args[0] === "ps") {
              return { stdout: [`c1\tsupabase_kong_other\t${otherProjectWorkdir}`] };
            }
            return defaultRoute()(args);
          },
        });
        const correctDir = path.join(
          otherProjectWorkdir,
          "supabase",
          ".temp",
          "start-secrets",
          "supabase_kong_other",
        );
        // Same container name, rooted at this invocation's own workdir — must survive, proving
        // cleanup never falls back to `cliSettings.workdir` while a real label is present.
        const wrongDir = path.join(
          workdir,
          "supabase",
          ".temp",
          "start-secrets",
          "supabase_kong_other",
        );
        yield* writeFileIn(correctDir, "secret-0", "kong.yml contents");
        yield* writeFileIn(wrongDir, "secret-0", "must not be touched");
        yield* stop(flags({ all: Option.some(true) })).pipe(Effect.provide(layer));
        expect(yield* fs.exists(correctDir)).toBe(false);
        expect(yield* fs.exists(wrongDir)).toBe(true);
      }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("sanitizes a dirty config.toml project_id before filtering, matching start's label", () =>
    Effect.gen(function* () {
      const { layer, child } = yield* setup({
        configuredProjectId: "My App!!",
        route: defaultRoute(),
      });
      yield* stop(flags()).pipe(Effect.provide(layer));
      const psCall = child.spawned.find((s) => s.args[0] === "ps");
      expect(psCall?.args).toEqual([
        "ps",
        "--filter",
        "label=com.supabase.cli.project=My_App_",
        "--all",
        "--format",
        '{{.ID}}\t{{.Names}}\t{{.Label "com.supabase.cli.workdir"}}',
      ]);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("keeps an explicit --project-id raw, unsanitized (Go's bypass)", () =>
    Effect.gen(function* () {
      const { layer, child } = yield* setup({ skipConfig: true, route: defaultRoute() });
      yield* stop(flags({ projectId: Option.some("Raw Value!!") })).pipe(Effect.provide(layer));
      const psCall = child.spawned.find((s) => s.args[0] === "ps");
      expect(psCall?.args).toEqual([
        "ps",
        "--filter",
        "label=com.supabase.cli.project=Raw Value!!",
        "--all",
        "--format",
        '{{.ID}}\t{{.Names}}\t{{.Label "com.supabase.cli.workdir"}}',
      ]);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("stops every project's containers with --all without reading config.toml", () =>
    Effect.gen(function* () {
      const { layer, child } = yield* setup({ skipConfig: true, route: defaultRoute() });
      yield* stop(flags({ all: Option.some(true) })).pipe(Effect.provide(layer));
      const psCall = child.spawned.find((s) => s.args[0] === "ps");
      expect(psCall?.args).toEqual([
        "ps",
        "--filter",
        "label=com.supabase.cli.project",
        "--all",
        "--format",
        '{{.ID}}\t{{.Names}}\t{{.Label "com.supabase.cli.workdir"}}',
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
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("suggests the bare-label volume command with --all when volumes remain", () =>
    Effect.gen(function* () {
      const { layer, out } = yield* setup({
        skipConfig: true,
        route: defaultRoute({ volumeNames: ["supabase_db_demo"] }),
      });
      yield* stop(flags({ all: Option.some(true) })).pipe(Effect.provide(layer));
      expect(out.stderrText).toContain(
        "Local data are backed up to docker volume. Use docker to show them:",
      );
      expect(out.stderrText).toContain("docker volume ls --filter label=com.supabase.cli.project");
      expect(out.stderrText).not.toContain("com.supabase.cli.project=");
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("stops a named project with --project-id without reading config.toml", () =>
    Effect.gen(function* () {
      const { layer, child } = yield* setup({ skipConfig: true, route: defaultRoute() });
      yield* stop(flags({ projectId: Option.some("other-project") })).pipe(Effect.provide(layer));
      const psCall = child.spawned.find((s) => s.args[0] === "ps");
      expect(psCall?.args).toEqual([
        "ps",
        "--filter",
        "label=com.supabase.cli.project=other-project",
        "--all",
        "--format",
        '{{.ID}}\t{{.Names}}\t{{.Label "com.supabase.cli.workdir"}}',
      ]);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("falls back to config.toml when --project-id is an empty string", () =>
    Effect.gen(function* () {
      const { layer, child } = yield* setup({
        configuredProjectId: "demo",
        route: defaultRoute(),
      });
      yield* stop(flags({ projectId: Option.some("") })).pipe(Effect.provide(layer));
      const psCall = child.spawned.find((s) => s.args[0] === "ps");
      expect(psCall?.args).toEqual([
        "ps",
        "--filter",
        "label=com.supabase.cli.project=demo",
        "--all",
        "--format",
        '{{.ID}}\t{{.Names}}\t{{.Label "com.supabase.cli.workdir"}}',
      ]);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("resolves SUPABASE_PROJECT_ID from supabase/.env over config.toml", () =>
    Effect.gen(function* () {
      const { layer, child } = yield* setup({
        configuredProjectId: "toml-project",
        route: defaultRoute(),
      });
      yield* writeSupabaseFile(tempRoot.current, ".env", "SUPABASE_PROJECT_ID=env-file-project\n");
      yield* stop(flags()).pipe(Effect.provide(layer));
      const psCall = child.spawned.find((s) => s.args[0] === "ps");
      expect(psCall?.args).toEqual([
        "ps",
        "--filter",
        "label=com.supabase.cli.project=env-file-project",
        "--all",
        "--format",
        '{{.ID}}\t{{.Names}}\t{{.Label "com.supabase.cli.workdir"}}',
      ]);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("prefers ambient SUPABASE_PROJECT_ID over supabase/.env", () =>
    Effect.gen(function* () {
      const { layer, child } = yield* setup({
        configuredProjectId: "toml-project",
        route: defaultRoute(),
      });
      yield* writeSupabaseFile(tempRoot.current, ".env", "SUPABASE_PROJECT_ID=env-file-project\n");
      yield* withEnvVar(
        "SUPABASE_PROJECT_ID",
        "ambient-project",
        stop(flags()).pipe(Effect.provide(layer)),
      );
      const psCall = child.spawned.find((s) => s.args[0] === "ps");
      expect(psCall?.args).toEqual([
        "ps",
        "--filter",
        "label=com.supabase.cli.project=ambient-project",
        "--all",
        "--format",
        '{{.ID}}\t{{.Names}}\t{{.Label "com.supabase.cli.workdir"}}',
      ]);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live(
    "does not climb to an ancestor project's config.toml when workdir has none of its own",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const nestedWorkdir = path.join(tempRoot.current, "nested");
        yield* fs.makeDirectory(nestedWorkdir, { recursive: true });
        yield* writeConfig(tempRoot.current, "ancestor-project");
        const projectId = path.basename(nestedWorkdir);
        const { layer, child } = yield* setup({
          workdir: nestedWorkdir,
          skipConfig: true,
          route: defaultRoute(),
        });
        yield* stop(flags()).pipe(Effect.provide(layer));
        const psCall = child.spawned.find((s) => s.args[0] === "ps");
        expect(psCall?.args).toEqual([
          "ps",
          "--filter",
          `label=com.supabase.cli.project=${projectId}`,
          "--all",
          "--format",
          '{{.ID}}\t{{.Names}}\t{{.Label "com.supabase.cli.workdir"}}',
        ]);
      }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("resolves SUPABASE_PROJECT_ID from supabase/.env even when config.toml is absent", () =>
    Effect.gen(function* () {
      const { layer, child } = yield* setup({ skipConfig: true, route: defaultRoute() });
      yield* writeSupabaseFile(tempRoot.current, ".env", "SUPABASE_PROJECT_ID=no-config-project\n");
      yield* stop(flags()).pipe(Effect.provide(layer));
      const psCall = child.spawned.find((s) => s.args[0] === "ps");
      expect(psCall?.args).toEqual([
        "ps",
        "--filter",
        "label=com.supabase.cli.project=no-config-project",
        "--all",
        "--format",
        '{{.ID}}\t{{.Names}}\t{{.Label "com.supabase.cli.workdir"}}',
      ]);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("resolves SUPABASE_PROJECT_ID from a project-root .env file", () =>
    Effect.gen(function* () {
      const { layer, child } = yield* setup({
        configuredProjectId: "toml-project",
        route: defaultRoute(),
      });
      yield* writeFileIn(tempRoot.current, ".env", "SUPABASE_PROJECT_ID=root-env-project\n");
      yield* stop(flags()).pipe(Effect.provide(layer));
      const psCall = child.spawned.find((s) => s.args[0] === "ps");
      expect(psCall?.args).toEqual([
        "ps",
        "--filter",
        "label=com.supabase.cli.project=root-env-project",
        "--all",
        "--format",
        '{{.ID}}\t{{.Names}}\t{{.Label "com.supabase.cli.workdir"}}',
      ]);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("fails when --workdir/SUPABASE_WORKDIR points at a missing path", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      // Must fail before falling through to the workdir-basename default.
      const missingWorkdir = path.join(tempRoot.current, "does-not-exist");
      const { layer, child } = yield* setup({ workdir: missingWorkdir, skipConfig: true });
      const exit = yield* Effect.exit(stop(flags()).pipe(Effect.provide(layer)));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const causeText = Cause.pretty(exit.cause);
        expect(causeText).toContain("StopWorkdirError");
        expect(causeText).toContain(
          `failed to change workdir: chdir ${missingWorkdir}: no such file or directory`,
        );
      }
      expect(child.spawned).toEqual([]);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("fails when --workdir/SUPABASE_WORKDIR points at a file, not a directory", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const filePath = path.join(tempRoot.current, "not-a-directory");
      yield* writeFileIn(tempRoot.current, "not-a-directory", "");
      const { layer, child } = yield* setup({ workdir: filePath, skipConfig: true });
      const exit = yield* Effect.exit(stop(flags()).pipe(Effect.provide(layer)));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const causeText = Cause.pretty(exit.cause);
        expect(causeText).toContain("StopWorkdirError");
        expect(causeText).toContain(`failed to change workdir: chdir ${filePath}: not a directory`);
      }
      expect(child.spawned).toEqual([]);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("rejects --project-id together with --all", () =>
    Effect.gen(function* () {
      const { layer, child } = yield* setup({ skipConfig: true, route: defaultRoute() });
      const exit = yield* Effect.exit(
        stop(flags({ projectId: Option.some("other-project"), all: Option.some(true) })).pipe(
          Effect.provide(layer),
        ),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toContain("StopMutuallyExclusiveError");
      }
      expect(child.spawned).toEqual([]);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  // Presence-based, not value-based: `--all=false` still counts as "set" alongside
  // `--project-id`, so this must reject too, not just `--all=true`.
  it.live("rejects --project-id together with an explicit --all=false", () =>
    Effect.gen(function* () {
      const { layer, child } = yield* setup({ skipConfig: true, route: defaultRoute() });
      const exit = yield* Effect.exit(
        stop(flags({ projectId: Option.some("other-project"), all: Option.some(false) })).pipe(
          Effect.provide(layer),
        ),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toContain("StopMutuallyExclusiveError");
      }
      expect(child.spawned).toEqual([]);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("deletes data volumes with --no-backup", () =>
    Effect.gen(function* () {
      const { layer, child } = yield* setup({
        configuredProjectId: "demo",
        route: defaultRoute(),
      });
      yield* stop(flags({ noBackup: true })).pipe(Effect.provide(layer));
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
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("omits --all from docker's volume prune on a pre-1.42 API host, matching Go's gate", () =>
    Effect.gen(function* () {
      // Docker's own `volume prune --all` requires API >= 1.42 and hard-fails (pruning
      // nothing) on an older daemon.
      const { layer, child } = yield* setup({
        configuredProjectId: "demo",
        route: defaultRoute({ dockerApiVersion: "1.41" }),
      });
      yield* stop(flags({ noBackup: true })).pipe(Effect.provide(layer));
      const volumePrune = child.spawned.find(
        (s) => s.command === "docker" && s.args[0] === "volume" && s.args[1] === "prune",
      );
      expect(volumePrune?.args).toEqual([
        "volume",
        "prune",
        "--force",
        "--filter",
        "label=com.supabase.cli.project=demo",
      ]);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("includes --all in docker's volume prune when the API is exactly 1.42", () =>
    Effect.gen(function* () {
      const { layer, child } = yield* setup({
        configuredProjectId: "demo",
        route: defaultRoute({ dockerApiVersion: "1.42" }),
      });
      yield* stop(flags({ noBackup: true })).pipe(Effect.provide(layer));
      const volumePrune = child.spawned.find(
        (s) => s.command === "docker" && s.args[0] === "volume" && s.args[1] === "prune",
      );
      expect(volumePrune?.args).toEqual([
        "volume",
        "prune",
        "--force",
        "--all",
        "--filter",
        "label=com.supabase.cli.project=demo",
      ]);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("--backup=false alone does not delete data volumes, matching Go's dead flag", () =>
    Effect.gen(function* () {
      const { layer, child } = yield* setup({
        configuredProjectId: "demo",
        route: defaultRoute(),
      });
      yield* stop(flags({ backup: false })).pipe(Effect.provide(layer));
      const volumePrune = child.spawned.find(
        (s) => s.args[0] === "volume" && s.args[1] === "prune",
      );
      expect(volumePrune).toBeUndefined();
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("--no-backup still deletes data volumes even when --backup stays true", () =>
    Effect.gen(function* () {
      const { layer, child } = yield* setup({
        configuredProjectId: "demo",
        route: defaultRoute(),
      });
      yield* stop(flags({ backup: true, noBackup: true })).pipe(Effect.provide(layer));
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
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("keeps data volumes by default (no volume prune call)", () =>
    Effect.gen(function* () {
      const { layer, child } = yield* setup({
        configuredProjectId: "demo",
        route: defaultRoute(),
      });
      yield* stop(flags()).pipe(Effect.provide(layer));
      const volumePrune = child.spawned.find(
        (s) => s.args[0] === "volume" && s.args[1] === "prune",
      );
      expect(volumePrune).toBeUndefined();
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("fails when config.toml is malformed", () =>
    Effect.gen(function* () {
      yield* writeSupabaseFile(tempRoot.current, "config.toml", "not valid toml =====");
      const { layer, child } = yield* setup({ skipConfig: true, route: defaultRoute() });
      const exit = yield* Effect.exit(stop(flags()).pipe(Effect.provide(layer)));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toContain("StopConfigLoadError");
      }
      expect(child.spawned).toEqual([]);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("fails when [remotes.*] has a duplicate project_id, even with no projectRef", () =>
    Effect.gen(function* () {
      yield* writeSupabaseFile(
        tempRoot.current,
        "config.toml",
        `project_id = "baseref"

[remotes.a]
project_id = "aaaaaaaaaaaaaaaaaaaa"

[remotes.b]
project_id = "aaaaaaaaaaaaaaaaaaaa"
`,
      );
      const { layer, child } = yield* setup({ skipConfig: true, route: defaultRoute() });
      const exit = yield* Effect.exit(stop(flags()).pipe(Effect.provide(layer)));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toContain("StopConfigLoadError");
      }
      expect(child.spawned).toEqual([]);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("fails when a [remotes.*] project_id is not a valid 20-letter ref", () =>
    Effect.gen(function* () {
      yield* writeSupabaseFile(
        tempRoot.current,
        "config.toml",
        `project_id = "baseref"

[remotes.bad]
project_id = "short"
`,
      );
      const { layer, child } = yield* setup({ skipConfig: true, route: defaultRoute() });
      const exit = yield* Effect.exit(stop(flags()).pipe(Effect.provide(layer)));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toContain("StopConfigLoadError");
      }
      expect(child.spawned).toEqual([]);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live(
    "decodes a comma-separated string into an array field ([]string) for stop to proceed",
    () =>
      Effect.gen(function* () {
        yield* writeSupabaseFile(
          tempRoot.current,
          "config.toml",
          `project_id = "demo"

[auth]
additional_redirect_urls = "http://a,http://b"
`,
        );
        const { layer, child } = yield* setup({ skipConfig: true, route: defaultRoute() });
        yield* stop(flags()).pipe(Effect.provide(layer));
        const psCall = child.spawned.find((s) => s.args[0] === "ps");
        expect(psCall?.args).toEqual([
          "ps",
          "--filter",
          "label=com.supabase.cli.project=demo",
          "--all",
          "--format",
          '{{.ID}}\t{{.Names}}\t{{.Label "com.supabase.cli.workdir"}}',
        ]);
      }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("warns on stderr for a deprecated auth.external provider", () =>
    Effect.gen(function* () {
      // `normalizeDeprecatedExternalProviders` (packages/config/src/io.ts) emits this warning via
      // `Console.error` only when `goViperCompat` is set.
      yield* writeSupabaseFile(
        tempRoot.current,
        "config.toml",
        `project_id = "demo"

[auth.external.slack]
enabled = true
`,
      );
      const { layer } = yield* setup({ skipConfig: true, route: defaultRoute() });
      const warnings: Array<string> = [];
      yield* Effect.acquireUseRelease(
        Effect.sync(() =>
          vi.spyOn(console, "error").mockImplementation((...args) => {
            warnings.push(args.map((a) => String(a)).join(" "));
          }),
        ),
        () =>
          Effect.gen(function* () {
            yield* stop(flags()).pipe(Effect.provide(layer));
            expect(
              warnings.some((m) => m.includes('WARN: disabling deprecated "slack" provider')),
            ).toBe(true);
          }),
        (errorSpy) =>
          Effect.sync(() => {
            errorSpy.mockRestore();
          }),
      );
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live(
    "fails and never spawns docker when config.toml has an unsupported db.major_version",
    () =>
      Effect.gen(function* () {
        yield* writeSupabaseFile(
          tempRoot.current,
          "config.toml",
          'project_id = "demo"\n[db]\nmajor_version = 12\n',
        );
        const { layer, child } = yield* setup({ skipConfig: true, route: defaultRoute() });
        const exit = yield* Effect.exit(stop(flags()).pipe(Effect.provide(layer)));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const causeText = Cause.pretty(exit.cause);
          expect(causeText).toContain("StopConfigLoadError");
          expect(causeText).toContain("Postgres version 12.x is unsupported");
        }
        expect(child.spawned).toEqual([]);
      }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("does not run config Validate for --all (bypasses config entirely)", () =>
    Effect.gen(function* () {
      yield* writeSupabaseFile(
        tempRoot.current,
        "config.toml",
        'project_id = "demo"\n[db]\nmajor_version = 12\n',
      );
      const { layer, child } = yield* setup({ skipConfig: true, route: defaultRoute() });
      const exit = yield* Effect.exit(
        stop(flags({ all: Option.some(true) })).pipe(Effect.provide(layer)),
      );
      expect(Exit.isSuccess(exit)).toBe(true);
      const psCall = child.spawned.find((s) => s.args[0] === "ps");
      expect(psCall?.args).toContain("label=com.supabase.cli.project");
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("does not run config Validate for --project-id (bypasses config entirely)", () =>
    Effect.gen(function* () {
      yield* writeSupabaseFile(
        tempRoot.current,
        "config.toml",
        'project_id = "demo"\n[db]\nmajor_version = 12\n',
      );
      const { layer, child } = yield* setup({ skipConfig: true, route: defaultRoute() });
      const exit = yield* Effect.exit(
        stop(flags({ projectId: Option.some("explicit") })).pipe(Effect.provide(layer)),
      );
      expect(Exit.isSuccess(exit)).toBe(true);
      const psCall = child.spawned.find((s) => s.args[0] === "ps");
      expect(psCall?.args).toContain("label=com.supabase.cli.project=explicit");
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("fails when stopping a container errors", () =>
    Effect.gen(function* () {
      const { layer } = yield* setup({
        configuredProjectId: "demo",
        route: (args) => {
          if (args[0] === "ps") return { stdout: ["c1"] };
          if (args[0] === "stop") return { exitCode: 1, stderr: ["boom"] };
          return { exitCode: 0 };
        },
      });
      const exit = yield* Effect.exit(stop(flags()).pipe(Effect.provide(layer)));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toContain("StopContainerError");
      }
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("preserves a container's staged-secret directory when the stop stage itself fails", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      // The stop stage failing means container prune never runs, so `onContainersRemoved` never
      // fires and `cleanupStartSecrets` must not delete anything.
      const { layer, workdir } = yield* setup({
        configuredProjectId: "demo",
        route: (args) => {
          if (args[0] === "ps") return { stdout: ["c1\tsupabase_kong_demo"] };
          if (args[0] === "stop") return { exitCode: 1, stderr: ["boom"] };
          return { exitCode: 0 };
        },
      });
      const stagedDir = path.join(
        workdir,
        "supabase",
        ".temp",
        "start-secrets",
        "supabase_kong_demo",
      );
      yield* writeFileIn(stagedDir, "secret-0", "kong.yml contents");
      const exit = yield* Effect.exit(stop(flags()).pipe(Effect.provide(layer)));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toContain("StopContainerError");
      }
      expect(yield* fs.exists(stagedDir)).toBe(true);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("fails when a container cannot be spawned to stop it at all", () =>
    Effect.gen(function* () {
      // Distinct from a spawned `docker stop` exiting non-zero: here docker and podman both
      // fail to spawn.
      const { layer } = yield* setup({
        configuredProjectId: "demo",
        route: (args) => (args[0] === "ps" ? { stdout: ["c1"] } : { exitCode: 0 }),
        failSpawnFor: (args) => args[0] === "stop",
      });
      const exit = yield* Effect.exit(stop(flags()).pipe(Effect.provide(layer)));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toContain("StopContainerError");
      }
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("fails the same way in json mode, where 'Stopping containers...' is never printed", () =>
    Effect.gen(function* () {
      const { layer } = yield* setup({
        format: "json",
        configuredProjectId: "demo",
        route: (args) => {
          if (args[0] === "ps") return { stdout: ["c1"] };
          if (args[0] === "stop") return { exitCode: 1, stderr: ["boom"] };
          return { exitCode: 0 };
        },
      });
      const exit = yield* Effect.exit(stop(flags()).pipe(Effect.provide(layer)));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toContain("StopContainerError");
      }
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("fails when container prune errors", () =>
    Effect.gen(function* () {
      const { layer } = yield* setup({
        configuredProjectId: "demo",
        route: (args) => {
          if (args[0] === "container" && args[1] === "prune") return { exitCode: 1 };
          return defaultRoute()(args);
        },
      });
      const exit = yield* Effect.exit(stop(flags()).pipe(Effect.provide(layer)));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toContain("StopContainerPruneError");
      }
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("fails when volume prune errors", () =>
    Effect.gen(function* () {
      const { layer } = yield* setup({
        configuredProjectId: "demo",
        route: (args) => {
          if (args[0] === "volume" && args[1] === "prune") return { exitCode: 1 };
          return defaultRoute()(args);
        },
      });
      const exit = yield* Effect.exit(stop(flags({ noBackup: true })).pipe(Effect.provide(layer)));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toContain("StopVolumePruneError");
      }
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("fails when network prune errors", () =>
    Effect.gen(function* () {
      const { layer } = yield* setup({
        configuredProjectId: "demo",
        route: (args) => {
          if (args[0] === "network" && args[1] === "prune") return { exitCode: 1 };
          return defaultRoute()(args);
        },
      });
      const exit = yield* Effect.exit(stop(flags()).pipe(Effect.provide(layer)));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toContain("StopNetworkPruneError");
      }
    }).pipe(Effect.provide(BunServices.layer)),
  );

  // By the time a later prune stage fails, container-prune has already removed the containers;
  // a subsequent `stop` could no longer rediscover them via `docker ps`, so this cleanup must
  // still run (see the `Effect.ensuring` finalizer above).
  it.live("still reclaims staged-secret directories when a later prune stage fails", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { layer, workdir } = yield* setup({
        configuredProjectId: "demo",
        route: (args) => {
          if (args[0] === "network" && args[1] === "prune") return { exitCode: 1 };
          return defaultRoute({ containerIds: ["supabase_kong_demo"] })(args);
        },
      });
      const matchedDir = path.join(
        workdir,
        "supabase",
        ".temp",
        "start-secrets",
        "supabase_kong_demo",
      );
      yield* writeFileIn(matchedDir, "secret-0", "kong.yml contents");
      const exit = yield* Effect.exit(stop(flags()).pipe(Effect.provide(layer)));
      expect(Exit.isFailure(exit)).toBe(true);
      expect(yield* fs.exists(matchedDir)).toBe(false);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("fails when the container list errors", () =>
    Effect.gen(function* () {
      const { layer } = yield* setup({
        configuredProjectId: "demo",
        route: (args) => {
          if (args[0] === "ps") return { exitCode: 1, stderr: ["daemon down"] };
          return { exitCode: 0 };
        },
      });
      const exit = yield* Effect.exit(stop(flags()).pipe(Effect.provide(layer)));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toContain("StopListError");
      }
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("falls back to podman when docker is absent", () =>
    Effect.gen(function* () {
      const { layer, child } = yield* setup({
        configuredProjectId: "demo",
        route: defaultRoute(),
        dockerMissing: true,
      });
      yield* stop(flags()).pipe(Effect.provide(layer));
      // The failed `docker` attempt is recorded before the `podman` fallback fires, so the
      // successful call is the last matching record, not the first.
      const psCalls = child.spawned.filter((s) => s.args[0] === "ps");
      expect(psCalls.at(-1)?.command).toBe("podman");
      expect(psCalls.some((s) => s.command === "docker")).toBe(true);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("omits --all from podman's volume prune (not a real Podman flag)", () =>
    Effect.gen(function* () {
      // Podman's `volume prune` has no `--all` flag; passing Docker's argv through would
      // hard-fail after containers are already stopped. Podman prunes every unused volume by
      // default, so dropping `--all` is lossless.
      const { layer, child } = yield* setup({
        configuredProjectId: "demo",
        route: defaultRoute(),
        dockerMissing: true,
      });
      yield* stop(flags({ noBackup: true })).pipe(Effect.provide(layer));
      const volumePruneCalls = child.spawned.filter(
        (s) => s.args[0] === "volume" && s.args[1] === "prune",
      );
      expect(volumePruneCalls.at(-1)?.command).toBe("podman");
      expect(volumePruneCalls.at(-1)?.args).toEqual([
        "volume",
        "prune",
        "--force",
        "--filter",
        "label=com.supabase.cli.project=demo",
      ]);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("emits a machine result in json mode without spinner text", () =>
    Effect.gen(function* () {
      const { layer, out } = yield* setup({
        format: "json",
        configuredProjectId: "demo",
        route: defaultRoute({ volumeNames: ["supabase_db_demo"] }),
      });
      yield* stop(flags()).pipe(Effect.provide(layer));
      const success = out.messages.find((m) => m.type === "success");
      expect(success?.data).toMatchObject({ project_id_filter: "demo", backup: true });
      expect(out.stdoutText).not.toContain("\x1b[?25l");
      // json mode has no volume-suggestion equivalent — only text mode emits it.
      expect(out.stderrText).not.toContain("Local data are backed up");
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("shows no volume suggestion when no volumes remain", () =>
    Effect.gen(function* () {
      const { layer, out } = yield* setup({
        configuredProjectId: "demo",
        route: defaultRoute({ volumeNames: [] }),
      });
      yield* stop(flags()).pipe(Effect.provide(layer));
      expect(out.stderrText).not.toContain("Local data are backed up");
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("flushes telemetry via ensuring even on failure", () =>
    Effect.gen(function* () {
      const { layer, telemetry } = yield* setup({
        configuredProjectId: "demo",
        route: (args) => (args[0] === "ps" ? { exitCode: 1 } : { exitCode: 0 }),
      });
      yield* Effect.exit(stop(flags()).pipe(Effect.provide(layer)));
      expect(telemetry.flushed).toBe(true);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("fails when container prune cannot spawn any container runtime", () =>
    Effect.gen(function* () {
      const { layer } = yield* setup({
        configuredProjectId: "demo",
        route: defaultRoute(),
        failSpawnFor: (args) => args[0] === "container" && args[1] === "prune",
      });
      const exit = yield* Effect.exit(stop(flags()).pipe(Effect.provide(layer)));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toContain("StopContainerPruneError");
      }
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("fails when volume prune cannot spawn any container runtime", () =>
    Effect.gen(function* () {
      const { layer } = yield* setup({
        configuredProjectId: "demo",
        route: defaultRoute(),
        failSpawnFor: (args) => args[0] === "volume" && args[1] === "prune",
      });
      const exit = yield* Effect.exit(stop(flags({ noBackup: true })).pipe(Effect.provide(layer)));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toContain("StopVolumePruneError");
      }
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("fails when network prune cannot spawn any container runtime", () =>
    Effect.gen(function* () {
      const { layer } = yield* setup({
        configuredProjectId: "demo",
        route: defaultRoute(),
        failSpawnFor: (args) => args[0] === "network" && args[1] === "prune",
      });
      const exit = yield* Effect.exit(stop(flags()).pipe(Effect.provide(layer)));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toContain("StopNetworkPruneError");
      }
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("still reports success when the post-run volume listing fails", () =>
    Effect.gen(function* () {
      // Best-effort (`Effect.orElseSucceed`): a listing error here is silently ignored, never
      // surfaced.
      const { layer, out } = yield* setup({
        configuredProjectId: "demo",
        route: defaultRoute(),
        failSpawnFor: (args) => args[0] === "volume" && args[1] === "ls",
      });
      yield* stop(flags()).pipe(Effect.provide(layer));
      expect(out.stdoutText).toContain("Stopped");
      expect(out.stderrText).not.toContain("Local data are backed up");
    }).pipe(Effect.provide(BunServices.layer)),
  );

  // `dockerRemoveAll`'s `--debug` prune reports write straight to `process.stderr`, bypassing
  // the mocked `Output` service — a raw `vi.spyOn` on `process.stderr.write` is the only way
  // to observe them.
  const pruneReportRoutes = (args: ReadonlyArray<string>): RouteResult => {
    if (args[0] === "container" && args[1] === "prune") {
      return { stdout: ["Deleted Containers:", "abc123", "", "Total reclaimed space: 42B"] };
    }
    if (args[0] === "volume" && args[1] === "prune") {
      return { stdout: ["vol1"] };
    }
    if (args[0] === "network" && args[1] === "prune") {
      return { stdout: ["Deleted Networks:", "net1"] };
    }
    return defaultRoute()(args);
  };

  const spyStderrWrite = Effect.sync(() =>
    vi.spyOn(process.stderr, "write").mockImplementation(() => true),
  );

  it.live("reports Go's --debug Pruned lines to stderr, in stage order", () =>
    Effect.gen(function* () {
      const { layer } = yield* setup({
        debug: true,
        configuredProjectId: "demo",
        route: pruneReportRoutes,
      });
      yield* Effect.acquireUseRelease(
        spyStderrWrite,
        (writeSpy) =>
          Effect.gen(function* () {
            yield* stop(flags({ noBackup: true })).pipe(Effect.provide(layer));
            const prunedWrites = writeSpy.mock.calls
              .map((call) => call[0])
              .filter(
                (chunk): chunk is string => typeof chunk === "string" && chunk.includes("Pruned"),
              );
            expect(prunedWrites).toEqual([
              "Pruned containers: [abc123]\n",
              "Pruned volumes: [vol1]\n",
              "Pruned network: [net1]\n",
            ]);
          }),
        (writeSpy) =>
          Effect.sync(() => {
            writeSpy.mockRestore();
          }),
      );
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("never writes Go's Pruned lines to stderr without --debug", () =>
    Effect.gen(function* () {
      const { layer } = yield* setup({
        configuredProjectId: "demo",
        route: pruneReportRoutes,
      });
      yield* Effect.acquireUseRelease(
        spyStderrWrite,
        (writeSpy) =>
          Effect.gen(function* () {
            yield* stop(flags({ noBackup: true })).pipe(Effect.provide(layer));
            const prunedWrites = writeSpy.mock.calls.filter(
              (call) => typeof call[0] === "string" && call[0].includes("Pruned"),
            );
            expect(prunedWrites).toEqual([]);
          }),
        (writeSpy) =>
          Effect.sync(() => {
            writeSpy.mockRestore();
          }),
      );
    }).pipe(Effect.provide(BunServices.layer)),
  );
});
