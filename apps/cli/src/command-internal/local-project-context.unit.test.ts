import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Config, ConfigProvider, Data, Effect, FileSystem, Layer, Option, Path } from "effect";

import { useTempWorkdir } from "../../tests/helpers/command-mocks.ts";
import { mockOutput, processEnvLayer } from "../../tests/helpers/mocks.ts";
import { CliConfigFlagInputs, makeCliConfigFlagInputs } from "../config/cli-config-flags.ts";
import { cliConfigValuesLayer } from "../config/cli-config-values.layer.ts";
import { runtimeInfoLayer } from "../shared/runtime/runtime-info.layer.ts";
import { sanitizeProjectId } from "../shared/config/project-id.ts";
import { loadLocalProjectContext } from "./local-project-context.ts";

/** Stands in for the whole Docker-client env-key set, which a project dotenv file never reaches. */
const DOCKER_HOST_KEY = "DOCKER_HOST";

/** Unlike Docker-client keys, this one is read at container-spawn time, so a project dotenv file can still set it. */
const BITBUCKET_CLONE_DIR_KEY = "BITBUCKET_CLONE_DIR";

const REF = "abcdefghijklmnopqrst";

class TestError extends Data.TaggedError("TestError")<{ readonly message: string }> {}

const writeDotEnv = Effect.fnUntraced(function* (workdir: string, contents: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(workdir, { recursive: true });
  yield* fs.writeFileString(path.join(workdir, ".env"), contents);
});

const writeConfigToml = Effect.fnUntraced(function* (workdir: string, contents: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const supabaseDir = path.join(workdir, "supabase");
  yield* fs.makeDirectory(supabaseDir, { recursive: true });
  yield* fs.writeFileString(path.join(supabaseDir, "config.toml"), contents);
});

const processEnvValue = (name: string) =>
  Effect.suspend(() =>
    Config.option(Config.String(name)).pipe(
      Effect.map(Option.getOrUndefined),
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromEnv({ preserveEmptyStrings: true }),
      ),
    ),
  );

/** Runs against a shell environment of exactly `env`, with the real config service. */
const layerWithShellEnv = (env: Readonly<Record<string, string>> = {}) =>
  Layer.fresh(
    Layer.mergeAll(
      BunServices.layer,
      runtimeInfoLayer,
      cliConfigValuesLayer.pipe(
        Layer.provide(
          Layer.mergeAll(
            BunServices.layer,
            mockOutput().layer,
            Layer.succeed(CliConfigFlagInputs, makeCliConfigFlagInputs()),
          ),
        ),
      ),
      processEnvLayer(env),
    ),
  );

const tempRoot = useTempWorkdir("supabase-project-context-");

const loadContext = (workdir: string, projectRef?: string) =>
  loadLocalProjectContext(workdir, (message) => new TestError({ message }), projectRef);

describe("loadLocalProjectContext", () => {
  it.effect("prefers SUPABASE_PROJECT_ID over a matched [remotes.<ref>]'s project_id", () => {
    const workdir = tempRoot.current;
    return Effect.gen(function* () {
      yield* writeConfigToml(
        workdir,
        ['project_id = "toml-project"', "[remotes.prod]", `project_id = "${REF}"`, ""].join("\n"),
      );

      const context = yield* loadContext(workdir, REF);
      expect(context.resolvedConfig.appliedRemote).toEqual(Option.some("prod"));
      expect(context.projectId).toBe("local");
    }).pipe(Effect.provide(layerWithShellEnv({ SUPABASE_PROJECT_ID: "local" })));
  });

  it.effect("names the project after the workdir, not the ref, when no project_id is set", () => {
    const workdir = tempRoot.current;
    return Effect.gen(function* () {
      const path = yield* Path.Path;
      yield* writeConfigToml(workdir, "");

      const context = yield* loadContext(workdir, REF);
      expect(context.resolvedConfig.appliedRemote).toEqual(Option.none());
      expect(context.projectId).toBe(sanitizeProjectId(path.basename(workdir)));
    }).pipe(Effect.provide(layerWithShellEnv()));
  });

  it.effect("applies SUPABASE_PROJECT_ID when no [remotes.*] block matches the ref", () => {
    const workdir = tempRoot.current;
    return Effect.gen(function* () {
      yield* writeConfigToml(workdir, ['project_id = "toml-project"', ""].join("\n"));

      const context = yield* loadContext(workdir, REF);
      expect(context.resolvedConfig.appliedRemote).toEqual(Option.none());
      expect(context.projectId).toBe("env-project");
    }).pipe(Effect.provide(layerWithShellEnv({ SUPABASE_PROJECT_ID: "env-project" })));
  });

  it.effect("does not install a project .env's DOCKER_HOST into process.env", () => {
    const workdir = tempRoot.current;
    return Effect.gen(function* () {
      yield* writeDotEnv(workdir, `DOCKER_HOST=tcp://project-dotenv-host:2375\n`);

      yield* loadContext(workdir);
      expect(yield* processEnvValue(DOCKER_HOST_KEY)).toBeUndefined();
    }).pipe(Effect.provide(layerWithShellEnv()));
  });

  it.effect(
    "leaves an already-set shell DOCKER_HOST untouched by a conflicting project .env",
    () => {
      const workdir = tempRoot.current;
      return Effect.gen(function* () {
        yield* writeDotEnv(workdir, `DOCKER_HOST=tcp://project-dotenv-host:2375\n`);

        yield* loadContext(workdir);
        expect(yield* processEnvValue(DOCKER_HOST_KEY)).toBe("tcp://real-shell-host:2375");
      }).pipe(
        Effect.provide(layerWithShellEnv({ [DOCKER_HOST_KEY]: "tcp://real-shell-host:2375" })),
      );
    },
  );

  it.effect("keeps a project's Bitbucket marker in its resolved environment", () => {
    const workdir = tempRoot.current;
    return Effect.gen(function* () {
      yield* writeDotEnv(workdir, `BITBUCKET_CLONE_DIR=/opt/atlassian/pipelines/agent/build\n`);

      const context = yield* loadContext(workdir);
      expect(context.projectEnvValues[BITBUCKET_CLONE_DIR_KEY]).toBe(
        "/opt/atlassian/pipelines/agent/build",
      );
      expect(yield* processEnvValue(BITBUCKET_CLONE_DIR_KEY)).toBeUndefined();
    }).pipe(Effect.provide(layerWithShellEnv()));
  });

  it.effect(
    "leaves a shell-set key out of projectEnvValues so the shell value stays the source",
    () => {
      const workdir = tempRoot.current;
      return Effect.gen(function* () {
        yield* writeDotEnv(workdir, `BITBUCKET_CLONE_DIR=/opt/atlassian/pipelines/agent/build\n`);

        const context = yield* loadContext(workdir);
        expect(context.projectEnvValues[BITBUCKET_CLONE_DIR_KEY]).toBeUndefined();
        expect(yield* processEnvValue(BITBUCKET_CLONE_DIR_KEY)).toBe("/real-shell-clone-dir");
      }).pipe(
        Effect.provide(layerWithShellEnv({ [BITBUCKET_CLONE_DIR_KEY]: "/real-shell-clone-dir" })),
      );
    },
  );

  it.effect("holds only project .env file values, never host environment variables", () => {
    const workdir = tempRoot.current;
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* writeConfigToml(workdir, "");
      yield* fs.writeFileString(path.join(workdir, "supabase", ".env"), "FROM_FILE=file-value\n");

      const context = yield* loadContext(workdir);
      expect(context.projectEnvValues).toEqual({ FROM_FILE: "file-value" });
    }).pipe(Effect.provide(layerWithShellEnv({ FROM_SHELL: "shell-value" })));
  });
});
