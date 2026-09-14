import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { Effect, Exit, Layer, Option } from "effect";
import { vi } from "vitest";

import { DebugFlag, NetworkIdFlag } from "./global-flags.ts";
import { RuntimeInfo } from "../shared/runtime/runtime-info.service.ts";
import { CommandSettings } from "../config/command-settings.service.ts";
import { DockerRun, type DockerRunOpts } from "./docker-run.service.ts";
import { edgeRuntimeScriptLayer } from "./edge-runtime-script.layer.ts";
import { EdgeRuntimeScript } from "./edge-runtime-script.service.ts";

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
    profile: "supabase",
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
    () => {
      const configWorkdir = mkdtempSync(join(tmpdir(), "edge-runtime-config-"));
      const callerWorkdir = mkdtempSync(join(tmpdir(), "edge-runtime-caller-"));
      mkdirSync(join(configWorkdir, "supabase", ".temp"), { recursive: true });
      writeFileSync(
        join(configWorkdir, "supabase", ".temp", "edge-runtime-version"),
        "v-from-config\n",
      );
      mkdirSync(join(callerWorkdir, "supabase", ".temp"), { recursive: true });
      writeFileSync(
        join(callerWorkdir, "supabase", ".temp", "edge-runtime-version"),
        "v-from-caller\n",
      );

      const { layer, docker } = setup(
        { exitCode: 1, stdout: "", stderr: "main worker has been destroyed\n" },
        { cliSettingsWorkdir: configWorkdir },
      );

      return Effect.gen(function* () {
        const edge = yield* EdgeRuntimeScript;
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
      }).pipe(
        Effect.provide(layer),
        Effect.ensuring(
          Effect.sync(() => {
            rmSync(configWorkdir, { recursive: true, force: true });
            rmSync(callerWorkdir, { recursive: true, force: true });
          }),
        ),
      );
    },
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
});
