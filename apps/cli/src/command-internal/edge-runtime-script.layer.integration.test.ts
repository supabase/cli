import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { Effect, Exit, FileSystem, Layer, Option, Path } from "effect";
import { vi } from "vitest";

import { DebugFlag, NetworkIdFlag } from "./global-flags.ts";
import { RuntimeInfo } from "../shared/runtime/runtime-info.service.ts";
import { runtimeInfoLayer } from "../shared/runtime/runtime-info.layer.ts";
import { CommandSettings } from "../config/command-settings.service.ts";
import { DockerRun, type DockerRunOpts } from "./docker-run.service.ts";
import { edgeRuntimeScriptLayer } from "./edge-runtime-script.layer.ts";
import { EdgeRuntimeScript } from "./edge-runtime-script.service.ts";
import { projectStateModeLayer } from "./project-state-mode.ts";
import { mockCommandSettings } from "../../tests/helpers/command-mocks.ts";
import { seedLegacyStateDecoys } from "../../tests/helpers/legacy-state-guard.ts";
import { seedLock } from "../../tests/helpers/stack-lock.ts";

// Fakes a `docker run --rm` capture. A real diff always exits non-zero with "main worker has
// been destroyed" in stderr; the crash path only differs by the added sentinel line.
function fakeDocker(result: { exitCode: number; stdout?: string; stderr?: string }) {
  let lastOpts: DockerRunOpts | undefined;
  return {
    layer: Layer.succeed(DockerRun, {
      runCapture: (opts) =>
        Effect.sync(() => {
          lastOpts = opts;
          return {
            exitCode: result.exitCode,
            stdout: new TextEncoder().encode(result.stdout ?? ""),
            stderr: result.stderr ?? "",
          };
        }),
      run: () => Effect.die("unused"),
      runStream: () => Effect.die("unused"),
    }),
    get lastOpts() {
      return lastOpts;
    },
  };
}

// Points at a directory with no `supabase/.temp/edge-runtime-version`, so the image resolver
// falls back to the default tag.
function makeCliSettings(workdir = "/nonexistent-workdir") {
  return Layer.succeed(CommandSettings, {
    dbPassword: Option.none(),
    githubToken: Option.none(),
    workdirEnvValue: Option.none(),
    profile: "supabase",
    profileEnvValue: Option.none(),
    supabaseHome: "/tmp/.supabase",
    apiUrl: "https://api.supabase.com",
    projectHost: "supabase.co",
    poolerHost: "supabase.co",
    dashboardUrl: "https://supabase.com/dashboard",
    accessToken: Option.none(),
    projectId: Option.none(),
    workdir,
    explicitWorkdir: false,
    userAgent: "test",
  });
}

function setup(
  result: { exitCode: number; stdout?: string; stderr?: string },
  opts: { readonly cliSettingsWorkdir?: string } = {},
) {
  const docker = fakeDocker(result);
  const layer = edgeRuntimeScriptLayer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        docker.layer,
        makeCliSettings(opts.cliSettingsWorkdir),
        Layer.succeed(RuntimeInfo, {
          cwd: "/nonexistent-workdir",
          platform: "darwin",
          arch: "arm64",
          homeDir: "/home/test",
          execPath: "/usr/bin/bun",
          pid: 1,
        }),
        Layer.succeed(DebugFlag, false),
        Layer.succeed(NetworkIdFlag, Option.none<string>()),
        BunServices.layer,
      ),
    ),
  );
  return { layer, docker };
}

const pinnedWorkdir = Effect.fnUntraced(function* (prefix: string, pin: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workdir = yield* fs.makeTempDirectoryScoped({ prefix });
  const tempDir = path.join(workdir, "supabase", ".temp");
  yield* fs.makeDirectory(tempDir, { recursive: true });
  yield* fs.writeFileString(path.join(tempDir, "edge-runtime-version"), pin);
  return workdir;
});

const runScript = Effect.fnUntraced(function* () {
  const edge = yield* EdgeRuntimeScript;
  return yield* edge.run({
    script: "console.log('x')",
    env: {},
    binds: [],
    errPrefix: "error diffing schema",
    denoVersion: 2,
  });
});

describe("edgeRuntimeScriptLayer sentinel handling", () => {
  it.effect(
    "fails with the real error when the script crashes behind the worker-destroyed message",
    () => {
      const stderr =
        "error: permission denied for table pg_user_mapping\n" +
        "PGDELTA_SCRIPT_ERROR\n" +
        "worker boot error\nmain worker has been destroyed\n";
      return runScript().pipe(
        Effect.exit,
        Effect.tap((exit) =>
          Effect.sync(() => {
            expect(Exit.isFailure(exit)).toBe(true);
            const error = Exit.isFailure(exit)
              ? exit.cause.reasons.find((r) => r._tag === "Fail")?.error
              : undefined;
            const message = (error as { message: string } | undefined)?.message ?? "";
            expect(message).toContain("error diffing schema: error running script:");
            expect(message).toContain("permission denied for table pg_user_mapping");
          }),
        ),
        Effect.provide(setup({ exitCode: 1, stdout: "", stderr }).layer),
      );
    },
  );

  it.effect("still succeeds on a worker-destroyed exit when no sentinel is present", () => {
    return runScript().pipe(
      Effect.tap((res) =>
        Effect.sync(() => {
          expect(res.stdout).toBe("ALTER TABLE x;\n");
        }),
      ),
      Effect.provide(
        setup({
          exitCode: 1,
          stdout: "ALTER TABLE x;\n",
          stderr: "main worker has been destroyed\n",
        }).layer,
      ),
    );
  });

  it.effect(
    "resolves the image pin from `opts.workdir`, overriding the layer's own `cliSettings.workdir`",
    () =>
      Effect.gen(function* () {
        const configWorkdir = yield* pinnedWorkdir("edge-runtime-config-", "v-from-config\n");
        const callerWorkdir = yield* pinnedWorkdir("edge-runtime-caller-", "v-from-caller\n");

        const { layer, docker } = setup(
          { exitCode: 1, stdout: "", stderr: "main worker has been destroyed\n" },
          { cliSettingsWorkdir: configWorkdir },
        );

        yield* Effect.gen(function* () {
          const edge = yield* EdgeRuntimeScript;
          yield* edge.run({
            script: "console.log('x')",
            env: {},
            binds: [],
            errPrefix: "error diffing schema",
            denoVersion: 2,
            workdir: callerWorkdir,
          });
        }).pipe(Effect.provide(layer));
        expect(docker.lastOpts?.image).toContain("edge-runtime:v-from-caller");
        expect(docker.lastOpts?.image).not.toContain("v-from-config");
      }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect(
    "runs on the Functions release locked in supabase.lock in stack state mode, ignoring the legacy pin",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const workdir = yield* fs.makeTempDirectoryScoped({ prefix: "edge-runtime-locked-" });
        yield* fs.makeDirectory(path.join(workdir, "supabase"), { recursive: true });
        yield* fs.writeFileString(
          path.join(workdir, "supabase", "config.toml"),
          'project_id = "test-project"\n',
        );
        // A stale lock fails the local stack commands; the tool container only reads the pin.
        yield* seedLock(workdir, (services) => ({
          ...services,
          rest: { ...services.rest, specifier: "v99.0.0" },
          functions: {
            ...services.functions,
            resolved: {
              ...services.functions.resolved,
              upstreamVersion: "v1.99.0",
              revision: 1,
              image: `ghcr.io/supabase/cli/edge-runtime:v1.99.0-r1@sha256:${"a".repeat(64)}`,
              upstreamImage: "supabase/edge-runtime:v1.99.0",
            },
          },
        })).pipe(
          Effect.provide(
            Layer.mergeAll(
              runtimeInfoLayer,
              mockCommandSettings({ workdir, supabaseHome: workdir }),
            ),
          ),
        );
        seedLegacyStateDecoys(workdir);

        const { layer, docker } = setup(
          { exitCode: 1, stdout: "", stderr: "main worker has been destroyed\n" },
          { cliSettingsWorkdir: workdir },
        );
        yield* runScript().pipe(Effect.provide(Layer.merge(layer, projectStateModeLayer("stack"))));

        expect(docker.lastOpts?.image).toContain("edge-runtime:v1.99.0");
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.effect(
    "runs on the locked slim image revision in stack state mode with the slim-images flag on",
    () =>
      Effect.gen(function* () {
        vi.stubEnv("SUPABASE_USE_SLIM_IMAGES", "1");
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const workdir = yield* fs.makeTempDirectoryScoped({ prefix: "edge-runtime-locked-slim-" });
        yield* fs.makeDirectory(path.join(workdir, "supabase"), { recursive: true });
        yield* fs.writeFileString(
          path.join(workdir, "supabase", "config.toml"),
          'project_id = "test-project"\n',
        );
        const lockedImage = `ghcr.io/supabase/cli/edge-runtime:v1.99.0-r1@sha256:${"a".repeat(64)}`;
        yield* seedLock(workdir, (services) => ({
          ...services,
          functions: {
            ...services.functions,
            resolved: {
              ...services.functions.resolved,
              upstreamVersion: "v1.99.0",
              revision: 1,
              image: lockedImage,
              upstreamImage: "supabase/edge-runtime:v1.99.0",
            },
          },
        })).pipe(
          Effect.provide(
            Layer.mergeAll(
              runtimeInfoLayer,
              mockCommandSettings({ workdir, supabaseHome: workdir }),
            ),
          ),
        );

        const { layer, docker } = setup(
          { exitCode: 1, stdout: "", stderr: "main worker has been destroyed\n" },
          { cliSettingsWorkdir: workdir },
        );
        yield* runScript().pipe(Effect.provide(Layer.merge(layer, projectStateModeLayer("stack"))));

        expect(docker.lastOpts?.image).toBe(lockedImage);
      }).pipe(
        Effect.scoped,
        Effect.provide(BunServices.layer),
        Effect.ensuring(Effect.sync(() => vi.unstubAllEnvs())),
      ),
  );

  it.effect("rewrites the runner onto the slim image with the slim-images flag on", () => {
    vi.stubEnv("SUPABASE_USE_SLIM_IMAGES", "1");
    const { layer, docker } = setup({
      exitCode: 1,
      stdout: "",
      stderr: "main worker has been destroyed\n",
    });
    return runScript().pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          expect(docker.lastOpts?.entrypoint).toStrictEqual(Option.some("sh"));
          expect(docker.lastOpts?.image).toContain("ghcr.io/supabase/cli/");
          expect(docker.lastOpts?.image).toContain("edge-runtime:");
        }),
      ),
      Effect.provide(layer),
      Effect.ensuring(Effect.sync(() => vi.unstubAllEnvs())),
    );
  });

  it.effect(
    "disables SELinux label separation so the container can read CLI-written workspace files",
    () => {
      const { layer, docker } = setup({
        exitCode: 1,
        stdout: "{}",
        stderr: "main worker has been destroyed\n",
      });
      return runScript().pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            expect(docker.lastOpts?.securityOpt).toEqual(["label:disable"]);
          }),
        ),
        Effect.provide(layer),
      );
    },
  );

  it.effect("forwards project dotenv values to the Docker invocation", () => {
    const { layer, docker } = setup({
      exitCode: 1,
      stdout: "{}",
      stderr: "main worker has been destroyed\n",
    });
    const projectEnvValues = { BITBUCKET_CLONE_DIR: "/pipeline/project" };
    return Effect.gen(function* () {
      const edge = yield* EdgeRuntimeScript;
      yield* edge.run({
        script: "console.log('x')",
        env: {},
        binds: ["supabase_edge_runtime_proj:/root/.cache/deno:rw"],
        errPrefix: "error diffing schema",
        denoVersion: 2,
        projectEnvValues,
      });
      expect(docker.lastOpts?.projectEnvValues).toEqual(projectEnvValues);
    }).pipe(Effect.provide(layer));
  });
});
