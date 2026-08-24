import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { Effect, Exit, FileSystem, Layer, Option, Path } from "effect";

import { LegacyDebugFlag, LegacyNetworkIdFlag } from "../../shared/legacy/global-flags.ts";
import { RuntimeInfo } from "../../shared/runtime/runtime-info.service.ts";
import { LegacyCliConfig } from "../config/legacy-cli-config.service.ts";
import { LegacyDockerRun, type LegacyDockerRunOpts } from "./legacy-docker-run.service.ts";
import { legacyEdgeRuntimeScriptLayer } from "./legacy-edge-runtime-script.layer.ts";
import { LegacyEdgeRuntimeScript } from "./legacy-edge-runtime-script.service.ts";
import { makeLegacyViperEnvLayer } from "../../shared/legacy/legacy-viper-env.ts";

// Fakes a `docker run --rm` capture: the pg-delta scripts throw to force the
// worker to exit, so a real diff always comes back with a non-zero exit and
// "main worker has been destroyed" in stderr — the crash path only differs by
// the sentinel line the templates' catch blocks add.
function fakeDocker(result: { exitCode: number; stdout?: string; stderr?: string }) {
  let lastOpts: LegacyDockerRunOpts | undefined;
  return {
    layer: Layer.succeed(LegacyDockerRun, {
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

// `workdir` points at a directory without `supabase/.temp/edge-runtime-version`,
// so the image resolver falls back to the default tag (the read is orElseSucceed).
function makeCliConfig(workdir = "/nonexistent-workdir") {
  return Layer.succeed(LegacyCliConfig, {
    profile: "supabase",
    apiUrl: "https://api.supabase.com",
    projectHost: "supabase.co",
    poolerHost: "supabase.co",
    dashboardUrl: "https://supabase.com/dashboard",
    accessToken: Option.none(),
    projectId: Option.none(),
    workdir,
    userAgent: "test",
  });
}

function setup(
  result: { exitCode: number; stdout?: string; stderr?: string },
  opts: { readonly cliConfigWorkdir?: string } = {},
) {
  const docker = fakeDocker(result);
  const layer = legacyEdgeRuntimeScriptLayer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        docker.layer,
        makeCliConfig(opts.cliConfigWorkdir),
        Layer.succeed(RuntimeInfo, {
          cwd: "/nonexistent-workdir",
          platform: "darwin",
          arch: "arm64",
          homeDir: "/home/test",
          execPath: "/usr/bin/bun",
          pid: 1,
        }),
        Layer.succeed(LegacyDebugFlag, false),
        Layer.succeed(LegacyNetworkIdFlag, Option.none<string>()),
        BunServices.layer,
        makeLegacyViperEnvLayer(),
      ),
    ),
  );
  return { layer, docker };
}

const runScript = Effect.fnUntraced(function* () {
  const edge = yield* LegacyEdgeRuntimeScript;
  return yield* edge.run({
    script: "console.log('x')",
    env: {},
    binds: [],
    errPrefix: "error diffing schema",
    denoVersion: 2,
  });
});

describe("legacyEdgeRuntimeScriptLayer sentinel handling", () => {
  it.effect(
    "fails with the real error when the script crashes behind the worker-destroyed message",
    () => {
      // The catch block emits the real error, the sentinel, and the worker is torn
      // down — all with a non-zero exit. This must surface, not read as an empty diff.
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
            // The actionable permission error must reach the user.
            expect(message).toContain("permission denied for table pg_user_mapping");
          }),
        ),
        Effect.provide(setup({ exitCode: 1, stdout: "", stderr }).layer),
      );
    },
  );

  it.effect("still succeeds on a worker-destroyed exit when no sentinel is present", () => {
    // Success path: the template forces the worker to exit after writing output, so
    // the exit is non-zero with "main worker has been destroyed" but no sentinel.
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
    "resolves the image pin from `opts.workdir`, overriding the layer's own `cliConfig.workdir`",
    () => {
      // Regression coverage (review thread on CLI-1953): `bootstrap` targets a
      // directory other than the invocation directory, and `LegacyCliConfig` is
      // built once, before that `process.chdir` runs — so its `workdir` never
      // reflects bootstrap's real target. `opts.workdir` (threaded from
      // `LegacyPgDeltaContext.cwd` by every pg-delta/migra caller) must win the
      // pin-file lookup instead.
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const configWorkdir = yield* fs.makeTempDirectory({ prefix: "edge-runtime-config-" });
        const callerWorkdir = yield* fs.makeTempDirectory({ prefix: "edge-runtime-caller-" });
        const configTemp = path.join(configWorkdir, "supabase", ".temp");
        const callerTemp = path.join(callerWorkdir, "supabase", ".temp");
        yield* fs.makeDirectory(configTemp, { recursive: true });
        yield* fs.writeFileString(path.join(configTemp, "edge-runtime-version"), "v-from-config\n");
        yield* fs.makeDirectory(callerTemp, { recursive: true });
        yield* fs.writeFileString(path.join(callerTemp, "edge-runtime-version"), "v-from-caller\n");

        const { layer, docker } = setup(
          { exitCode: 1, stdout: "", stderr: "main worker has been destroyed\n" },
          { cliConfigWorkdir: configWorkdir },
        );
        yield* Effect.gen(function* () {
          const edge = yield* LegacyEdgeRuntimeScript;
          yield* edge.run({
            script: "console.log('x')",
            env: {},
            binds: [],
            errPrefix: "error diffing schema",
            denoVersion: 2,
            workdir: callerWorkdir,
          });
          expect(docker.lastOpts?.image).toContain("edge-runtime:v-from-caller");
          expect(docker.lastOpts?.image).not.toContain("v-from-config");
        }).pipe(Effect.provide(layer));
        yield* fs.remove(configWorkdir, { recursive: true, force: true });
        yield* fs.remove(callerWorkdir, { recursive: true, force: true });
      }).pipe(Effect.provide(BunServices.layer));
    },
  );

  it.effect(
    "disables SELinux label separation so the container can read CLI-written workspace files",
    () => {
      // Without this the pg-delta CA bundle written under `supabase/.temp/pgdelta/`
      // is unreadable through the `/workspace` bind on SELinux hosts (supabase/cli#5989).
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
});
