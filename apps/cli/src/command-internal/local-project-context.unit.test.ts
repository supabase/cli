import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";

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

function writeDotEnv(workdir: string, contents: string): void {
  mkdirSync(workdir, { recursive: true });
  writeFileSync(join(workdir, ".env"), contents);
}

function writeConfigToml(workdir: string, contents: string): void {
  const supabaseDir = join(workdir, "supabase");
  mkdirSync(supabaseDir, { recursive: true });
  writeFileSync(join(supabaseDir, "config.toml"), contents);
}

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

describe("loadLocalProjectContext", () => {
  it.effect("prefers SUPABASE_PROJECT_ID over a matched [remotes.<ref>]'s project_id", () => {
    const workdir = tempRoot.current;
    writeConfigToml(
      workdir,
      ['project_id = "toml-project"', "[remotes.prod]", `project_id = "${REF}"`, ""].join("\n"),
    );

    return loadLocalProjectContext(workdir, (message) => new Error(message), REF).pipe(
      Effect.map((context) => {
        expect(context.resolvedConfig.appliedRemote).toEqual(Option.some("prod"));
        expect(context.projectId).toBe("local");
      }),
      Effect.provide(layerWithShellEnv({ SUPABASE_PROJECT_ID: "local" })),
    );
  });

  it.effect("names the project after the workdir, not the ref, when no project_id is set", () => {
    const workdir = tempRoot.current;
    writeConfigToml(workdir, "");

    return loadLocalProjectContext(workdir, (message) => new Error(message), REF).pipe(
      Effect.map((context) => {
        expect(context.resolvedConfig.appliedRemote).toEqual(Option.none());
        expect(context.projectId).toBe(sanitizeProjectId(basename(workdir)));
      }),
      Effect.provide(layerWithShellEnv()),
    );
  });

  it.effect("applies SUPABASE_PROJECT_ID when no [remotes.*] block matches the ref", () => {
    const workdir = tempRoot.current;
    writeConfigToml(workdir, ['project_id = "toml-project"', ""].join("\n"));

    return loadLocalProjectContext(workdir, (message) => new Error(message), REF).pipe(
      Effect.map((context) => {
        expect(context.resolvedConfig.appliedRemote).toEqual(Option.none());
        expect(context.projectId).toBe("env-project");
      }),
      Effect.provide(layerWithShellEnv({ SUPABASE_PROJECT_ID: "env-project" })),
    );
  });

  it.effect("does not install a project .env's DOCKER_HOST into process.env", () => {
    const workdir = tempRoot.current;
    writeDotEnv(workdir, `DOCKER_HOST=tcp://project-dotenv-host:2375\n`);

    return loadLocalProjectContext(workdir, (message) => new Error(message)).pipe(
      Effect.map(() => {
        expect(process.env[DOCKER_HOST_KEY]).toBeUndefined();
      }),
      Effect.provide(layerWithShellEnv()),
    );
  });

  it.effect(
    "leaves an already-set shell DOCKER_HOST untouched by a conflicting project .env",
    () => {
      const workdir = tempRoot.current;
      writeDotEnv(workdir, `DOCKER_HOST=tcp://project-dotenv-host:2375\n`);

      return loadLocalProjectContext(workdir, (message) => new Error(message)).pipe(
        Effect.map(() => {
          expect(process.env[DOCKER_HOST_KEY]).toBe("tcp://real-shell-host:2375");
        }),
        Effect.provide(layerWithShellEnv({ [DOCKER_HOST_KEY]: "tcp://real-shell-host:2375" })),
      );
    },
  );

  it.effect("keeps a project's Bitbucket marker in its resolved environment", () => {
    const workdir = tempRoot.current;
    writeDotEnv(workdir, `BITBUCKET_CLONE_DIR=/opt/atlassian/pipelines/agent/build\n`);

    return loadLocalProjectContext(workdir, (message) => new Error(message)).pipe(
      Effect.map((context) => {
        expect(context.projectEnvValues[BITBUCKET_CLONE_DIR_KEY]).toBe(
          "/opt/atlassian/pipelines/agent/build",
        );
        expect(process.env[BITBUCKET_CLONE_DIR_KEY]).toBeUndefined();
      }),
      Effect.provide(layerWithShellEnv()),
    );
  });

  it.effect(
    "leaves a shell-set key out of projectEnvValues so the shell value stays the source",
    () => {
      const workdir = tempRoot.current;
      writeDotEnv(workdir, `BITBUCKET_CLONE_DIR=/opt/atlassian/pipelines/agent/build\n`);

      return loadLocalProjectContext(workdir, (message) => new Error(message)).pipe(
        Effect.map((context) => {
          expect(context.projectEnvValues[BITBUCKET_CLONE_DIR_KEY]).toBeUndefined();
          expect(process.env[BITBUCKET_CLONE_DIR_KEY]).toBe("/real-shell-clone-dir");
        }),
        Effect.provide(layerWithShellEnv({ [BITBUCKET_CLONE_DIR_KEY]: "/real-shell-clone-dir" })),
      );
    },
  );

  it.effect("holds only project .env file values, never host environment variables", () => {
    const workdir = tempRoot.current;
    writeConfigToml(workdir, "");
    writeFileSync(join(workdir, "supabase", ".env"), "FROM_FILE=file-value\n");

    return loadLocalProjectContext(workdir, (message) => new Error(message)).pipe(
      Effect.map((context) => {
        expect(context.projectEnvValues).toEqual({ FROM_FILE: "file-value" });
      }),
      Effect.provide(layerWithShellEnv({ FROM_SHELL: "shell-value" })),
    );
  });
});
