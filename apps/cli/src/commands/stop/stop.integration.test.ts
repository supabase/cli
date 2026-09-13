import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Exit, Layer, Option, PlatformError, Sink, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { vi } from "vitest";

import { mockOutput } from "../../../tests/helpers/mocks.ts";
import {
  mockCommandSettings,
  mockTelemetryStateTracked,
  useTempWorkdir,
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

function writeConfig(workdir: string, projectId: string) {
  const supabaseDir = join(workdir, "supabase");
  mkdirSync(supabaseDir, { recursive: true });
  writeFileSync(join(supabaseDir, "config.toml"), `project_id = "${projectId}"\n`);
}

function writeEnvFile(workdir: string, fileName: ".env" | ".env.local", contents: string) {
  const supabaseDir = join(workdir, "supabase");
  mkdirSync(supabaseDir, { recursive: true });
  writeFileSync(join(supabaseDir, fileName), contents);
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

function setup(opts: SetupOpts = {}) {
  const workdir = opts.workdir ?? tempRoot.current;
  if (opts.skipConfig !== true) {
    writeConfig(workdir, opts.configuredProjectId ?? "demo");
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
}

describe("stop integration", () => {
  it.live(
    "stops the current project's containers with backup and suggests the volume command",
    () => {
      const { layer, out, child } = setup({
        configuredProjectId: "demo",
        route: defaultRoute({ containerIds: ["c1", "c2"], volumeNames: ["supabase_db_demo"] }),
      });
      return Effect.gen(function* () {
        yield* stop(flags());
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
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "reclaims staged-secret directories for containers it tears down, leaving unrelated ones alone",
    () => {
      // `defaultRoute`'s `ps` stdout has no workdir-label column, so this also exercises the
      // fallback to `cliSettings.workdir` for containers with no `com.supabase.cli.workdir` label.
      const { layer, workdir } = setup({
        configuredProjectId: "demo",
        route: defaultRoute({ containerIds: ["supabase_kong_demo"] }),
      });
      const startSecretsDir = join(workdir, "supabase", ".temp", "start-secrets");
      const matchedDir = join(startSecretsDir, "supabase_kong_demo");
      const unmatchedDir = join(startSecretsDir, "supabase_kong_other-project");
      mkdirSync(matchedDir, { recursive: true });
      writeFileSync(join(matchedDir, "secret-0"), "kong.yml contents");
      mkdirSync(unmatchedDir, { recursive: true });
      writeFileSync(join(unmatchedDir, "secret-0"), "unrelated project's secret");
      return Effect.gen(function* () {
        yield* stop(flags());
        expect(existsSync(matchedDir)).toBe(false);
        expect(existsSync(unmatchedDir)).toBe(true);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "reclaims a container's staged-secret directory at its OWN labeled workdir, not this invocation's cwd",
    () => {
      // Simulates `stop --all` tearing down a container from a different project than this
      // invocation's own cwd/`--workdir`.
      const workdir = tempRoot.current;
      const otherProjectWorkdir = join(workdir, "other-project-root");
      const { layer } = setup({
        workdir,
        skipConfig: true,
        route: (args) => {
          if (args[0] === "ps") {
            return { stdout: [`c1\tsupabase_kong_other\t${otherProjectWorkdir}`] };
          }
          return defaultRoute()(args);
        },
      });
      const correctDir = join(
        otherProjectWorkdir,
        "supabase",
        ".temp",
        "start-secrets",
        "supabase_kong_other",
      );
      // Same container name, rooted at this invocation's own workdir — must survive, proving
      // cleanup never falls back to `cliSettings.workdir` while a real label is present.
      const wrongDir = join(workdir, "supabase", ".temp", "start-secrets", "supabase_kong_other");
      mkdirSync(correctDir, { recursive: true });
      writeFileSync(join(correctDir, "secret-0"), "kong.yml contents");
      mkdirSync(wrongDir, { recursive: true });
      writeFileSync(join(wrongDir, "secret-0"), "must not be touched");
      return Effect.gen(function* () {
        yield* stop(flags({ all: Option.some(true) }));
        expect(existsSync(correctDir)).toBe(false);
        expect(existsSync(wrongDir)).toBe(true);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "sanitizes a dirty config.toml project_id before filtering, matching start's label",
    () => {
      const { layer, child } = setup({
        configuredProjectId: "My App!!",
        route: defaultRoute(),
      });
      return Effect.gen(function* () {
        yield* stop(flags());
        const psCall = child.spawned.find((s) => s.args[0] === "ps");
        expect(psCall?.args).toEqual([
          "ps",
          "--filter",
          "label=com.supabase.cli.project=My_App_",
          "--all",
          "--format",
          '{{.ID}}\t{{.Names}}\t{{.Label "com.supabase.cli.workdir"}}',
        ]);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("keeps an explicit --project-id raw, unsanitized (Go's bypass)", () => {
    const { layer, child } = setup({ skipConfig: true, route: defaultRoute() });
    return Effect.gen(function* () {
      yield* stop(flags({ projectId: Option.some("Raw Value!!") }));
      const psCall = child.spawned.find((s) => s.args[0] === "ps");
      expect(psCall?.args).toEqual([
        "ps",
        "--filter",
        "label=com.supabase.cli.project=Raw Value!!",
        "--all",
        "--format",
        '{{.ID}}\t{{.Names}}\t{{.Label "com.supabase.cli.workdir"}}',
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.live("stops every project's containers with --all without reading config.toml", () => {
    const { layer, child } = setup({ skipConfig: true, route: defaultRoute() });
    return Effect.gen(function* () {
      yield* stop(flags({ all: Option.some(true) }));
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
    }).pipe(Effect.provide(layer));
  });

  it.live("suggests the bare-label volume command with --all when volumes remain", () => {
    const { layer, out } = setup({
      skipConfig: true,
      route: defaultRoute({ volumeNames: ["supabase_db_demo"] }),
    });
    return Effect.gen(function* () {
      yield* stop(flags({ all: Option.some(true) }));
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
      yield* stop(flags({ projectId: Option.some("other-project") }));
      const psCall = child.spawned.find((s) => s.args[0] === "ps");
      expect(psCall?.args).toEqual([
        "ps",
        "--filter",
        "label=com.supabase.cli.project=other-project",
        "--all",
        "--format",
        '{{.ID}}\t{{.Names}}\t{{.Label "com.supabase.cli.workdir"}}',
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.live("falls back to config.toml when --project-id is an empty string", () => {
    const { layer, child } = setup({ configuredProjectId: "demo", route: defaultRoute() });
    return Effect.gen(function* () {
      yield* stop(flags({ projectId: Option.some("") }));
      const psCall = child.spawned.find((s) => s.args[0] === "ps");
      expect(psCall?.args).toEqual([
        "ps",
        "--filter",
        "label=com.supabase.cli.project=demo",
        "--all",
        "--format",
        '{{.ID}}\t{{.Names}}\t{{.Label "com.supabase.cli.workdir"}}',
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.live("resolves SUPABASE_PROJECT_ID from supabase/.env over config.toml", () => {
    const { layer, child } = setup({ configuredProjectId: "toml-project", route: defaultRoute() });
    writeEnvFile(tempRoot.current, ".env", "SUPABASE_PROJECT_ID=env-file-project\n");
    return Effect.gen(function* () {
      yield* stop(flags());
      const psCall = child.spawned.find((s) => s.args[0] === "ps");
      expect(psCall?.args).toEqual([
        "ps",
        "--filter",
        "label=com.supabase.cli.project=env-file-project",
        "--all",
        "--format",
        '{{.ID}}\t{{.Names}}\t{{.Label "com.supabase.cli.workdir"}}',
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.live("prefers ambient SUPABASE_PROJECT_ID over supabase/.env", () => {
    const { layer, child } = setup({ configuredProjectId: "toml-project", route: defaultRoute() });
    writeEnvFile(tempRoot.current, ".env", "SUPABASE_PROJECT_ID=env-file-project\n");
    process.env["SUPABASE_PROJECT_ID"] = "ambient-project";
    return Effect.gen(function* () {
      yield* stop(flags());
      const psCall = child.spawned.find((s) => s.args[0] === "ps");
      expect(psCall?.args).toEqual([
        "ps",
        "--filter",
        "label=com.supabase.cli.project=ambient-project",
        "--all",
        "--format",
        '{{.ID}}\t{{.Names}}\t{{.Label "com.supabase.cli.workdir"}}',
      ]);
    }).pipe(
      Effect.provide(layer),
      Effect.ensuring(Effect.sync(() => delete process.env["SUPABASE_PROJECT_ID"])),
    );
  });

  it.live(
    "does not climb to an ancestor project's config.toml when workdir has none of its own",
    () => {
      const nestedWorkdir = join(tempRoot.current, "nested");
      mkdirSync(nestedWorkdir, { recursive: true });
      writeConfig(tempRoot.current, "ancestor-project");
      const projectId = basename(nestedWorkdir);
      const { layer, child } = setup({
        workdir: nestedWorkdir,
        skipConfig: true,
        route: defaultRoute(),
      });
      return Effect.gen(function* () {
        yield* stop(flags());
        const psCall = child.spawned.find((s) => s.args[0] === "ps");
        expect(psCall?.args).toEqual([
          "ps",
          "--filter",
          `label=com.supabase.cli.project=${projectId}`,
          "--all",
          "--format",
          '{{.ID}}\t{{.Names}}\t{{.Label "com.supabase.cli.workdir"}}',
        ]);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("resolves SUPABASE_PROJECT_ID from supabase/.env even when config.toml is absent", () => {
    const { layer, child } = setup({ skipConfig: true, route: defaultRoute() });
    writeEnvFile(tempRoot.current, ".env", "SUPABASE_PROJECT_ID=no-config-project\n");
    return Effect.gen(function* () {
      yield* stop(flags());
      const psCall = child.spawned.find((s) => s.args[0] === "ps");
      expect(psCall?.args).toEqual([
        "ps",
        "--filter",
        "label=com.supabase.cli.project=no-config-project",
        "--all",
        "--format",
        '{{.ID}}\t{{.Names}}\t{{.Label "com.supabase.cli.workdir"}}',
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.live("resolves SUPABASE_PROJECT_ID from a project-root .env file", () => {
    const { layer, child } = setup({ configuredProjectId: "toml-project", route: defaultRoute() });
    writeFileSync(join(tempRoot.current, ".env"), "SUPABASE_PROJECT_ID=root-env-project\n");
    return Effect.gen(function* () {
      yield* stop(flags());
      const psCall = child.spawned.find((s) => s.args[0] === "ps");
      expect(psCall?.args).toEqual([
        "ps",
        "--filter",
        "label=com.supabase.cli.project=root-env-project",
        "--all",
        "--format",
        '{{.ID}}\t{{.Names}}\t{{.Label "com.supabase.cli.workdir"}}',
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.live("fails when --workdir/SUPABASE_WORKDIR points at a missing path", () => {
    // Must fail before falling through to the workdir-basename default.
    const missingWorkdir = join(tempRoot.current, "does-not-exist");
    const { layer, child } = setup({ workdir: missingWorkdir, skipConfig: true });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(stop(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("StopWorkdirError");
        expect(JSON.stringify(exit.cause)).toContain(
          `failed to change workdir: chdir ${missingWorkdir}: no such file or directory`,
        );
      }
      expect(child.spawned).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.live("fails when --workdir/SUPABASE_WORKDIR points at a file, not a directory", () => {
    const filePath = join(tempRoot.current, "not-a-directory");
    writeFileSync(filePath, "");
    const { layer, child } = setup({ workdir: filePath, skipConfig: true });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(stop(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("StopWorkdirError");
        expect(JSON.stringify(exit.cause)).toContain(
          `failed to change workdir: chdir ${filePath}: not a directory`,
        );
      }
      expect(child.spawned).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.live("rejects --project-id together with --all", () => {
    const { layer, child } = setup({ skipConfig: true, route: defaultRoute() });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        stop(flags({ projectId: Option.some("other-project"), all: Option.some(true) })),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("StopMutuallyExclusiveError");
      }
      expect(child.spawned).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  // Presence-based, not value-based: `--all=false` still counts as "set" alongside
  // `--project-id`, so this must reject too, not just `--all=true`.
  it.live("rejects --project-id together with an explicit --all=false", () => {
    const { layer, child } = setup({ skipConfig: true, route: defaultRoute() });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        stop(flags({ projectId: Option.some("other-project"), all: Option.some(false) })),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("StopMutuallyExclusiveError");
      }
      expect(child.spawned).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.live("deletes data volumes with --no-backup", () => {
    const { layer, child } = setup({ configuredProjectId: "demo", route: defaultRoute() });
    return Effect.gen(function* () {
      yield* stop(flags({ noBackup: true }));
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

  it.live(
    "omits --all from docker's volume prune on a pre-1.42 API host, matching Go's gate",
    () => {
      // Docker's own `volume prune --all` requires API >= 1.42 and hard-fails (pruning
      // nothing) on an older daemon.
      const { layer, child } = setup({
        configuredProjectId: "demo",
        route: defaultRoute({ dockerApiVersion: "1.41" }),
      });
      return Effect.gen(function* () {
        yield* stop(flags({ noBackup: true }));
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
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("includes --all in docker's volume prune when the API is exactly 1.42", () => {
    const { layer, child } = setup({
      configuredProjectId: "demo",
      route: defaultRoute({ dockerApiVersion: "1.42" }),
    });
    return Effect.gen(function* () {
      yield* stop(flags({ noBackup: true }));
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
    }).pipe(Effect.provide(layer));
  });

  it.live("--backup=false alone does not delete data volumes, matching Go's dead flag", () => {
    const { layer, child } = setup({ configuredProjectId: "demo", route: defaultRoute() });
    return Effect.gen(function* () {
      yield* stop(flags({ backup: false }));
      const volumePrune = child.spawned.find(
        (s) => s.args[0] === "volume" && s.args[1] === "prune",
      );
      expect(volumePrune).toBeUndefined();
    }).pipe(Effect.provide(layer));
  });

  it.live("--no-backup still deletes data volumes even when --backup stays true", () => {
    const { layer, child } = setup({ configuredProjectId: "demo", route: defaultRoute() });
    return Effect.gen(function* () {
      yield* stop(flags({ backup: true, noBackup: true }));
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
      yield* stop(flags());
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
      const exit = yield* Effect.exit(stop(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("StopConfigLoadError");
      }
      expect(child.spawned).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.live("fails when [remotes.*] has a duplicate project_id, even with no projectRef", () => {
    const workdir = tempRoot.current;
    mkdirSync(join(workdir, "supabase"), { recursive: true });
    writeFileSync(
      join(workdir, "supabase", "config.toml"),
      `project_id = "baseref"

[remotes.a]
project_id = "aaaaaaaaaaaaaaaaaaaa"

[remotes.b]
project_id = "aaaaaaaaaaaaaaaaaaaa"
`,
    );
    const { layer, child } = setup({ skipConfig: true, route: defaultRoute() });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(stop(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("StopConfigLoadError");
      }
      expect(child.spawned).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.live("fails when a [remotes.*] project_id is not a valid 20-letter ref", () => {
    const workdir = tempRoot.current;
    mkdirSync(join(workdir, "supabase"), { recursive: true });
    writeFileSync(
      join(workdir, "supabase", "config.toml"),
      `project_id = "baseref"

[remotes.bad]
project_id = "short"
`,
    );
    const { layer, child } = setup({ skipConfig: true, route: defaultRoute() });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(stop(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("StopConfigLoadError");
      }
      expect(child.spawned).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "decodes a comma-separated string into an array field ([]string) for stop to proceed",
    () => {
      const workdir = tempRoot.current;
      mkdirSync(join(workdir, "supabase"), { recursive: true });
      writeFileSync(
        join(workdir, "supabase", "config.toml"),
        `project_id = "demo"

[auth]
additional_redirect_urls = "http://a,http://b"
`,
      );
      const { layer, child } = setup({ skipConfig: true, route: defaultRoute() });
      return Effect.gen(function* () {
        yield* stop(flags());
        const psCall = child.spawned.find((s) => s.args[0] === "ps");
        expect(psCall?.args).toEqual([
          "ps",
          "--filter",
          "label=com.supabase.cli.project=demo",
          "--all",
          "--format",
          '{{.ID}}\t{{.Names}}\t{{.Label "com.supabase.cli.workdir"}}',
        ]);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("warns on stderr for a deprecated auth.external provider", () => {
    // `normalizeDeprecatedExternalProviders` (packages/config/src/io.ts) emits this warning via
    // `Console.error` only when `goViperCompat` is set.
    const workdir = tempRoot.current;
    mkdirSync(join(workdir, "supabase"), { recursive: true });
    writeFileSync(
      join(workdir, "supabase", "config.toml"),
      `project_id = "demo"

[auth.external.slack]
enabled = true
`,
    );
    const { layer } = setup({ skipConfig: true, route: defaultRoute() });
    const warnings: Array<string> = [];
    const errorSpy = vi.spyOn(console, "error").mockImplementation((...args) => {
      warnings.push(args.map((a) => String(a)).join(" "));
    });
    return Effect.gen(function* () {
      yield* stop(flags());
      expect(warnings.some((m) => m.includes('WARN: disabling deprecated "slack" provider'))).toBe(
        true,
      );
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(() => errorSpy.mockRestore())));
  });

  it.live(
    "fails and never spawns docker when config.toml has an unsupported db.major_version",
    () => {
      const workdir = tempRoot.current;
      mkdirSync(join(workdir, "supabase"), { recursive: true });
      writeFileSync(
        join(workdir, "supabase", "config.toml"),
        'project_id = "demo"\n[db]\nmajor_version = 12\n',
      );
      const { layer, child } = setup({ skipConfig: true, route: defaultRoute() });
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(stop(flags()));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(JSON.stringify(exit.cause)).toContain("StopConfigLoadError");
          expect(JSON.stringify(exit.cause)).toContain("Postgres version 12.x is unsupported");
        }
        expect(child.spawned).toEqual([]);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("does not run config Validate for --all (bypasses config entirely)", () => {
    const workdir = tempRoot.current;
    mkdirSync(join(workdir, "supabase"), { recursive: true });
    writeFileSync(
      join(workdir, "supabase", "config.toml"),
      'project_id = "demo"\n[db]\nmajor_version = 12\n',
    );
    const { layer, child } = setup({ skipConfig: true, route: defaultRoute() });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(stop(flags({ all: Option.some(true) })));
      expect(Exit.isSuccess(exit)).toBe(true);
      const psCall = child.spawned.find((s) => s.args[0] === "ps");
      expect(psCall?.args).toContain("label=com.supabase.cli.project");
    }).pipe(Effect.provide(layer));
  });

  it.live("does not run config Validate for --project-id (bypasses config entirely)", () => {
    const workdir = tempRoot.current;
    mkdirSync(join(workdir, "supabase"), { recursive: true });
    writeFileSync(
      join(workdir, "supabase", "config.toml"),
      'project_id = "demo"\n[db]\nmajor_version = 12\n',
    );
    const { layer, child } = setup({ skipConfig: true, route: defaultRoute() });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(stop(flags({ projectId: Option.some("explicit") })));
      expect(Exit.isSuccess(exit)).toBe(true);
      const psCall = child.spawned.find((s) => s.args[0] === "ps");
      expect(psCall?.args).toContain("label=com.supabase.cli.project=explicit");
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
      const exit = yield* Effect.exit(stop(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("StopContainerError");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "preserves a container's staged-secret directory when the stop stage itself fails",
    () => {
      // The stop stage failing means container prune never runs, so `onContainersRemoved` never
      // fires and `cleanupStartSecrets` must not delete anything.
      const { layer, workdir } = setup({
        configuredProjectId: "demo",
        route: (args) => {
          if (args[0] === "ps") return { stdout: ["c1\tsupabase_kong_demo"] };
          if (args[0] === "stop") return { exitCode: 1, stderr: ["boom"] };
          return { exitCode: 0 };
        },
      });
      const stagedDir = join(workdir, "supabase", ".temp", "start-secrets", "supabase_kong_demo");
      mkdirSync(stagedDir, { recursive: true });
      writeFileSync(join(stagedDir, "secret-0"), "kong.yml contents");
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(stop(flags()));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(JSON.stringify(exit.cause)).toContain("StopContainerError");
        }
        expect(existsSync(stagedDir)).toBe(true);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("fails when a container cannot be spawned to stop it at all", () => {
    // Distinct from a spawned `docker stop` exiting non-zero: here docker and podman both
    // fail to spawn.
    const { layer } = setup({
      configuredProjectId: "demo",
      route: (args) => (args[0] === "ps" ? { stdout: ["c1"] } : { exitCode: 0 }),
      failSpawnFor: (args) => args[0] === "stop",
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(stop(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("StopContainerError");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "fails the same way in json mode, where 'Stopping containers...' is never printed",
    () => {
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
        const exit = yield* Effect.exit(stop(flags()));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(JSON.stringify(exit.cause)).toContain("StopContainerError");
        }
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("fails when container prune errors", () => {
    const { layer } = setup({
      configuredProjectId: "demo",
      route: (args) => {
        if (args[0] === "container" && args[1] === "prune") return { exitCode: 1 };
        return defaultRoute()(args);
      },
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(stop(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("StopContainerPruneError");
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
      const exit = yield* Effect.exit(stop(flags({ noBackup: true })));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("StopVolumePruneError");
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
      const exit = yield* Effect.exit(stop(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("StopNetworkPruneError");
      }
    }).pipe(Effect.provide(layer));
  });

  // By the time a later prune stage fails, container-prune has already removed the containers;
  // a subsequent `stop` could no longer rediscover them via `docker ps`, so this cleanup must
  // still run (see the `Effect.ensuring` finalizer above).
  it.live("still reclaims staged-secret directories when a later prune stage fails", () => {
    const { layer, workdir } = setup({
      configuredProjectId: "demo",
      route: (args) => {
        if (args[0] === "network" && args[1] === "prune") return { exitCode: 1 };
        return defaultRoute({ containerIds: ["supabase_kong_demo"] })(args);
      },
    });
    const matchedDir = join(workdir, "supabase", ".temp", "start-secrets", "supabase_kong_demo");
    mkdirSync(matchedDir, { recursive: true });
    writeFileSync(join(matchedDir, "secret-0"), "kong.yml contents");
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(stop(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      expect(existsSync(matchedDir)).toBe(false);
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
      const exit = yield* Effect.exit(stop(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("StopListError");
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
      yield* stop(flags());
      // The failed `docker` attempt is recorded before the `podman` fallback fires, so the
      // successful call is the last matching record, not the first.
      const psCalls = child.spawned.filter((s) => s.args[0] === "ps");
      expect(psCalls.at(-1)?.command).toBe("podman");
      expect(psCalls.some((s) => s.command === "docker")).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("omits --all from podman's volume prune (not a real Podman flag)", () => {
    // Podman's `volume prune` has no `--all` flag; passing Docker's argv through would
    // hard-fail after containers are already stopped. Podman prunes every unused volume by
    // default, so dropping `--all` is lossless.
    const { layer, child } = setup({
      configuredProjectId: "demo",
      route: defaultRoute(),
      dockerMissing: true,
    });
    return Effect.gen(function* () {
      yield* stop(flags({ noBackup: true }));
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
    }).pipe(Effect.provide(layer));
  });

  it.live("emits a machine result in json mode without spinner text", () => {
    const { layer, out } = setup({
      format: "json",
      configuredProjectId: "demo",
      route: defaultRoute({ volumeNames: ["supabase_db_demo"] }),
    });
    return Effect.gen(function* () {
      yield* stop(flags());
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
      yield* stop(flags());
      expect(out.stderrText).not.toContain("Local data are backed up");
    }).pipe(Effect.provide(layer));
  });

  it.live("flushes telemetry via ensuring even on failure", () => {
    const { layer, telemetry } = setup({
      configuredProjectId: "demo",
      route: (args) => (args[0] === "ps" ? { exitCode: 1 } : { exitCode: 0 }),
    });
    return Effect.gen(function* () {
      yield* Effect.exit(stop(flags()));
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
      const exit = yield* Effect.exit(stop(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("StopContainerPruneError");
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
      const exit = yield* Effect.exit(stop(flags({ noBackup: true })));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("StopVolumePruneError");
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
      const exit = yield* Effect.exit(stop(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("StopNetworkPruneError");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("still reports success when the post-run volume listing fails", () => {
    // Best-effort (`Effect.orElseSucceed`): a listing error here is silently ignored, never
    // surfaced.
    const { layer, out } = setup({
      configuredProjectId: "demo",
      route: defaultRoute(),
      failSpawnFor: (args) => args[0] === "volume" && args[1] === "ls",
    });
    return Effect.gen(function* () {
      yield* stop(flags());
      expect(out.stdoutText).toContain("Stopped");
      expect(out.stderrText).not.toContain("Local data are backed up");
    }).pipe(Effect.provide(layer));
  });

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

  it.live("reports Go's --debug Pruned lines to stderr, in stage order", () => {
    const { layer } = setup({
      debug: true,
      configuredProjectId: "demo",
      route: pruneReportRoutes,
    });
    const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    return Effect.gen(function* () {
      yield* stop(flags({ noBackup: true }));
      const prunedWrites = writeSpy.mock.calls
        .map((call) => call[0])
        .filter((chunk): chunk is string => typeof chunk === "string" && chunk.includes("Pruned"));
      expect(prunedWrites).toEqual([
        "Pruned containers: [abc123]\n",
        "Pruned volumes: [vol1]\n",
        "Pruned network: [net1]\n",
      ]);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(() => writeSpy.mockRestore())));
  });

  it.live("never writes Go's Pruned lines to stderr without --debug", () => {
    const { layer } = setup({
      configuredProjectId: "demo",
      route: pruneReportRoutes,
    });
    const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    return Effect.gen(function* () {
      yield* stop(flags({ noBackup: true }));
      const prunedWrites = writeSpy.mock.calls.filter(
        (call) => typeof call[0] === "string" && call[0].includes("Pruned"),
      );
      expect(prunedWrites).toEqual([]);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(() => writeSpy.mockRestore())));
  });
});
