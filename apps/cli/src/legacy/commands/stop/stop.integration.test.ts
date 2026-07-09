import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Exit, Layer, Option, PlatformError, Sink, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { vi } from "vitest";

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

/**
 * Default happy-path router: `ps` lists one container, `docker version` reports
 * an API version comfortably at/above the `volume prune --all` gate (1.42, see
 * `legacyDockerSupportsVolumePruneAllFlag`), everything else succeeds empty.
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
    if (args[0] === "ps") return { stdout: containerIds };
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
      yield* legacyStop(flags({ all: Option.some(true) }));
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
      yield* legacyStop(flags({ all: Option.some(true) }));
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

  it.live("falls back to config.toml when --project-id is an empty string", () => {
    // Go's check is `len(projectId) > 0` (internal/stop/stop.go:18), not just
    // "was --project-id set" — an empty value must fall through to config.toml
    // exactly like an absent flag, not resolve to the bare/all-projects filter.
    const { layer, child } = setup({ configuredProjectId: "demo", route: defaultRoute() });
    return Effect.gen(function* () {
      yield* legacyStop(flags({ projectId: Option.some("") }));
      const psCall = child.spawned.find((s) => s.args[0] === "ps");
      expect(psCall?.args).toEqual([
        "ps",
        "--filter",
        "label=com.supabase.cli.project=demo",
        "--all",
        "--format",
        "{{.ID}}",
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.live("resolves SUPABASE_PROJECT_ID from supabase/.env over config.toml", () => {
    // Go's Config.Load runs loadNestedEnv (supabase/.env(.local) via godotenv)
    // before loadFromFile's AutomaticEnv reads SUPABASE_PROJECT_ID
    // (pkg/config/config.go:735-738) — an env-file-only value overrides
    // config.toml's project_id too, not just an ambient shell export.
    const { layer, child } = setup({ configuredProjectId: "toml-project", route: defaultRoute() });
    writeEnvFile(tempRoot.current, ".env", "SUPABASE_PROJECT_ID=env-file-project\n");
    return Effect.gen(function* () {
      yield* legacyStop(flags());
      const psCall = child.spawned.find((s) => s.args[0] === "ps");
      expect(psCall?.args).toEqual([
        "ps",
        "--filter",
        "label=com.supabase.cli.project=env-file-project",
        "--all",
        "--format",
        "{{.ID}}",
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.live("prefers ambient SUPABASE_PROJECT_ID over supabase/.env", () => {
    const { layer, child } = setup({ configuredProjectId: "toml-project", route: defaultRoute() });
    writeEnvFile(tempRoot.current, ".env", "SUPABASE_PROJECT_ID=env-file-project\n");
    process.env["SUPABASE_PROJECT_ID"] = "ambient-project";
    return Effect.gen(function* () {
      yield* legacyStop(flags());
      const psCall = child.spawned.find((s) => s.args[0] === "ps");
      expect(psCall?.args).toEqual([
        "ps",
        "--filter",
        "label=com.supabase.cli.project=ambient-project",
        "--all",
        "--format",
        "{{.ID}}",
      ]);
    }).pipe(
      Effect.provide(layer),
      Effect.ensuring(Effect.sync(() => delete process.env["SUPABASE_PROJECT_ID"])),
    );
  });

  it.live(
    "does not climb to an ancestor project's config.toml when workdir has none of its own",
    () => {
      // Go's ChangeWorkDir uses an explicit/defaulted workdir exactly, with no
      // ancestor search (apps/cli-go/internal/utils/misc.go:231-247) — mirrored
      // here by `search: false`. A workdir with no supabase/config.toml of its
      // own must fall back to defaults (workdir-basename project id), not an
      // ancestor project's config.toml, even though `cliConfig.workdir` sits
      // right inside one.
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
        yield* legacyStop(flags());
        const psCall = child.spawned.find((s) => s.args[0] === "ps");
        expect(psCall?.args).toEqual([
          "ps",
          "--filter",
          `label=com.supabase.cli.project=${projectId}`,
          "--all",
          "--format",
          "{{.ID}}",
        ]);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("resolves SUPABASE_PROJECT_ID from supabase/.env even when config.toml is absent", () => {
    // Go's loadNestedEnv runs unconditionally, before config.toml is ever
    // opened (pkg/config/config.go:786-793) — a supabase/.env-only project id
    // must still be honored even when there's no config.toml to fall back to
    // template defaults from.
    const { layer, child } = setup({ skipConfig: true, route: defaultRoute() });
    writeEnvFile(tempRoot.current, ".env", "SUPABASE_PROJECT_ID=no-config-project\n");
    return Effect.gen(function* () {
      yield* legacyStop(flags());
      const psCall = child.spawned.find((s) => s.args[0] === "ps");
      expect(psCall?.args).toEqual([
        "ps",
        "--filter",
        "label=com.supabase.cli.project=no-config-project",
        "--all",
        "--format",
        "{{.ID}}",
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.live("resolves SUPABASE_PROJECT_ID from a project-root .env file", () => {
    // Go's loadNestedEnv walks past supabase/ one more level, to the project
    // root/workdir (pkg/config/config.go:1169-1190) — a project-root-only
    // dotenv value must override config.toml too, not just supabase/.env.
    const { layer, child } = setup({ configuredProjectId: "toml-project", route: defaultRoute() });
    writeFileSync(join(tempRoot.current, ".env"), "SUPABASE_PROJECT_ID=root-env-project\n");
    return Effect.gen(function* () {
      yield* legacyStop(flags());
      const psCall = child.spawned.find((s) => s.args[0] === "ps");
      expect(psCall?.args).toEqual([
        "ps",
        "--filter",
        "label=com.supabase.cli.project=root-env-project",
        "--all",
        "--format",
        "{{.ID}}",
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.live("fails when --workdir/SUPABASE_WORKDIR points at a missing path", () => {
    // Go's `ChangeWorkDir` (`apps/cli-go/internal/utils/misc.go:231-250`)
    // `os.Chdir`s the explicit workdir in `PersistentPreRunE`, before any of
    // `stop`'s own flag validation, config load, or Docker access — a missing
    // path must fail immediately, not fall through to the workdir-basename
    // default and prune under that name.
    const missingWorkdir = join(tempRoot.current, "does-not-exist");
    const { layer, child } = setup({ workdir: missingWorkdir, skipConfig: true });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyStop(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("LegacyStopWorkdirError");
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
      const exit = yield* Effect.exit(legacyStop(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("LegacyStopWorkdirError");
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
        legacyStop(flags({ projectId: Option.some("other-project"), all: Option.some(true) })),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("LegacyStopMutuallyExclusiveError");
      }
      expect(child.spawned).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  // Cobra's `MarkFlagsMutuallyExclusive` mutex is presence-based (`Changed`),
  // not value-based — `--all=false` still counts as "set" alongside
  // `--project-id`, so this must reject too, not just `--all`/`--all=true`.
  it.live("rejects --project-id together with an explicit --all=false", () => {
    const { layer, child } = setup({ skipConfig: true, route: defaultRoute() });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacyStop(flags({ projectId: Option.some("other-project"), all: Option.some(false) })),
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

  it.live(
    "omits --all from docker's volume prune on a pre-1.42 API host, matching Go's gate",
    () => {
      // Docker CLI's own `volume prune --all` flag requires API >= 1.42 and
      // hard-fails (pruning nothing) on an older daemon — Go avoids ever
      // sending it by checking `Docker.ClientVersion() >= "1.42"`
      // (docker.go:126-133). This mirrors that gate via `docker version`.
      const { layer, child } = setup({
        configuredProjectId: "demo",
        route: defaultRoute({ dockerApiVersion: "1.41" }),
      });
      return Effect.gen(function* () {
        yield* legacyStop(flags({ noBackup: true }));
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
      yield* legacyStop(flags({ noBackup: true }));
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

  it.live("fails when [remotes.*] has a duplicate project_id, even with no projectRef", () => {
    // Go's Config.Validate builds the duplicate map across all [remotes.*]
    // blocks unconditionally (config.go:503-518), so this must fail before
    // stop ever selects a remote or touches Docker — not just when a
    // matching --project-ref is requested.
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
      const exit = yield* Effect.exit(legacyStop(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("LegacyStopConfigLoadError");
      }
      expect(child.spawned).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.live("fails when a [remotes.*] project_id is not a valid 20-letter ref", () => {
    // Go's Config.Validate (config.go:996-1001) checks every [remotes.*].project_id
    // against refPattern unconditionally on every config load, so an invalid
    // format must fail closed before stop reaches Docker.
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
      const exit = yield* Effect.exit(legacyStop(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("LegacyStopConfigLoadError");
      }
      expect(child.spawned).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "decodes a comma-separated string into an array field ([]string) for stop to proceed",
    () => {
      // Go's `newDecodeHook` wires `mapstructure.StringToSliceHookFunc(",")`
      // unconditionally, so a plain string value for a `[]string` field like
      // `additional_redirect_urls` decodes fine and must not block stop from
      // reaching Docker.
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
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("warns on stderr for a deprecated auth.external provider", () => {
    // `normalizeDeprecatedExternalProviders` (packages/config/src/io.ts) emits
    // this WARN via `Console.error` only when `goViperCompat` is set — verify
    // legacy stop keeps that Go-parity behavior wired on.
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
      yield* legacyStop(flags());
      expect(warnings.some((m) => m.includes('WARN: disabling deprecated "slack" provider'))).toBe(
        true,
      );
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(() => errorSpy.mockRestore())));
  });

  it.live(
    "fails and never spawns docker when config.toml has an unsupported db.major_version",
    () => {
      // Matches Go's default `stop` path, which runs `flags.LoadConfig` (config
      // load + `Validate`) entirely before any Docker call
      // (`internal/stop/stop.go:15-25` -> `pkg/config/config.go:882`) — a config
      // Go rejects must fail `stop` before it touches containers, not just when
      // reading `project_id`.
      const workdir = tempRoot.current;
      mkdirSync(join(workdir, "supabase"), { recursive: true });
      writeFileSync(
        join(workdir, "supabase", "config.toml"),
        'project_id = "demo"\n[db]\nmajor_version = 12\n',
      );
      const { layer, child } = setup({ skipConfig: true, route: defaultRoute() });
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(legacyStop(flags()));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(JSON.stringify(exit.cause)).toContain("LegacyStopConfigLoadError");
          expect(JSON.stringify(exit.cause)).toContain("Postgres version 12.x is unsupported");
        }
        expect(child.spawned).toEqual([]);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("does not run config Validate for --all (bypasses config entirely)", () => {
    // `internal/stop/stop.go:15-25`: the `--all` branch never calls
    // `flags.LoadConfig`, so an otherwise-invalid config.toml must not block it.
    const workdir = tempRoot.current;
    mkdirSync(join(workdir, "supabase"), { recursive: true });
    writeFileSync(
      join(workdir, "supabase", "config.toml"),
      'project_id = "demo"\n[db]\nmajor_version = 12\n',
    );
    const { layer, child } = setup({ skipConfig: true, route: defaultRoute() });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyStop(flags({ all: Option.some(true) })));
      expect(Exit.isSuccess(exit)).toBe(true);
      const psCall = child.spawned.find((s) => s.args[0] === "ps");
      expect(psCall?.args).toContain("label=com.supabase.cli.project");
    }).pipe(Effect.provide(layer));
  });

  it.live("does not run config Validate for --project-id (bypasses config entirely)", () => {
    // `internal/stop/stop.go:15-25`: an explicit `--project-id` sets
    // `Config.ProjectId` directly and never calls `flags.LoadConfig`.
    const workdir = tempRoot.current;
    mkdirSync(join(workdir, "supabase"), { recursive: true });
    writeFileSync(
      join(workdir, "supabase", "config.toml"),
      'project_id = "demo"\n[db]\nmajor_version = 12\n',
    );
    const { layer, child } = setup({ skipConfig: true, route: defaultRoute() });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyStop(flags({ projectId: Option.some("explicit") })));
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

  it.live(
    "fails the same way in json mode, where 'Stopping containers...' is never printed",
    () => {
      // The `output.format === "text"` gate around the "Stopping containers..."
      // line means json mode skips it entirely; this exercises that the
      // list/stop/prune failure path is unaffected by that gate.
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

  it.live("omits --all from podman's volume prune (not a real Podman flag)", () => {
    // No released Podman `volume prune` accepts `--all` (only `--filter`/`--force`/
    // `--help`), so passing Docker's `--all` argv straight through to the Podman
    // fallback would hard-fail after containers are already stopped. Podman prunes
    // every unused volume by default, so dropping `--all` there is lossless.
    const { layer, child } = setup({
      configuredProjectId: "demo",
      route: defaultRoute(),
      dockerMissing: true,
    });
    return Effect.gen(function* () {
      yield* legacyStop(flags({ noBackup: true }));
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
