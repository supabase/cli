import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { afterEach, describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { useTempWorkdir } from "../../tests/helpers/command-mocks.ts";
import { loadLocalProjectContext } from "./local-project-context.ts";
import { runtimeInfoLayer } from "../shared/runtime/runtime-info.layer.ts";

/** Stands in for the whole Docker-client env-key set, which a project dotenv file never reaches. */
const DOCKER_HOST_KEY = "DOCKER_HOST";

/** Unlike Docker-client keys, this one is read at container-spawn time, so a project dotenv file can still set it. */
const BITBUCKET_CLONE_DIR_KEY = "BITBUCKET_CLONE_DIR";

function writeDotEnv(workdir: string, contents: string): void {
  mkdirSync(workdir, { recursive: true });
  writeFileSync(join(workdir, ".env"), contents);
}

function writeConfigToml(workdir: string, contents: string): void {
  const supabaseDir = join(workdir, "supabase");
  mkdirSync(supabaseDir, { recursive: true });
  writeFileSync(join(supabaseDir, "config.toml"), contents);
}

const tempRoot = useTempWorkdir("supabase-project-context-");

describe("loadLocalProjectContext", () => {
  const previousDockerHost = process.env[DOCKER_HOST_KEY];
  const previousBitbucketCloneDir = process.env[BITBUCKET_CLONE_DIR_KEY];
  const previousProjectId = process.env["SUPABASE_PROJECT_ID"];

  afterEach(() => {
    if (previousDockerHost === undefined) delete process.env[DOCKER_HOST_KEY];
    else process.env[DOCKER_HOST_KEY] = previousDockerHost;
    if (previousBitbucketCloneDir === undefined) delete process.env[BITBUCKET_CLONE_DIR_KEY];
    else process.env[BITBUCKET_CLONE_DIR_KEY] = previousBitbucketCloneDir;
    if (previousProjectId === undefined) delete process.env["SUPABASE_PROJECT_ID"];
    else process.env["SUPABASE_PROJECT_ID"] = previousProjectId;
  });

  it.effect(
    "prefers a matched [remotes.<ref>]'s project_id over a conflicting SUPABASE_PROJECT_ID",
    () => {
      process.env["SUPABASE_PROJECT_ID"] = "local";
      const ref = "abcdefghijklmnopqrst";
      const workdir = tempRoot.current;
      writeConfigToml(
        workdir,
        ['project_id = "toml-project"', "[remotes.prod]", `project_id = "${ref}"`, ""].join("\n"),
      );

      return loadLocalProjectContext(workdir, (message) => new Error(message), ref).pipe(
        Effect.map((context) => {
          expect(context.loaded?.appliedRemote).toBe("prod");
          expect(context.projectId).toBe(ref);
        }),
        Effect.provide(Layer.mergeAll(BunServices.layer, runtimeInfoLayer)),
      );
    },
  );

  it.effect("still applies SUPABASE_PROJECT_ID when no [remotes.*] block matches the ref", () => {
    process.env["SUPABASE_PROJECT_ID"] = "env-project";
    const ref = "abcdefghijklmnopqrst";
    const workdir = tempRoot.current;
    writeConfigToml(workdir, ['project_id = "toml-project"', ""].join("\n"));

    return loadLocalProjectContext(workdir, (message) => new Error(message), ref).pipe(
      Effect.map((context) => {
        expect(context.loaded?.appliedRemote).toBeUndefined();
        expect(context.projectId).toBe("env-project");
      }),
      Effect.provide(Layer.mergeAll(BunServices.layer, runtimeInfoLayer)),
    );
  });

  it.effect(
    "does NOT install a project .env's DOCKER_HOST into process.env, matching Go's Docker client being frozen at binary startup, before godotenv.Load ever runs",
    () => {
      delete process.env[DOCKER_HOST_KEY];
      const workdir = tempRoot.current;
      writeDotEnv(workdir, `DOCKER_HOST=tcp://project-dotenv-host:2375\n`);

      return loadLocalProjectContext(workdir, (message) => new Error(message)).pipe(
        Effect.map(() => {
          expect(process.env[DOCKER_HOST_KEY]).toBeUndefined();
        }),
        Effect.provide(Layer.mergeAll(BunServices.layer, runtimeInfoLayer)),
      );
    },
  );

  it.effect(
    "leaves an already-set shell DOCKER_HOST untouched regardless of a conflicting project .env value",
    () => {
      process.env[DOCKER_HOST_KEY] = "tcp://real-shell-host:2375";
      const workdir = tempRoot.current;
      writeDotEnv(workdir, `DOCKER_HOST=tcp://project-dotenv-host:2375\n`);

      return loadLocalProjectContext(workdir, (message) => new Error(message)).pipe(
        Effect.map(() => {
          expect(process.env[DOCKER_HOST_KEY]).toBe("tcp://real-shell-host:2375");
        }),
        Effect.provide(Layer.mergeAll(BunServices.layer, runtimeInfoLayer)),
      );
    },
  );

  it.effect("keeps a project's Bitbucket marker in its resolved environment", () => {
    delete process.env[BITBUCKET_CLONE_DIR_KEY];
    const workdir = tempRoot.current;
    writeDotEnv(workdir, `BITBUCKET_CLONE_DIR=/opt/atlassian/pipelines/agent/build\n`);

    return loadLocalProjectContext(workdir, (message) => new Error(message)).pipe(
      Effect.map((context) => {
        expect(context.projectEnvValues[BITBUCKET_CLONE_DIR_KEY]).toBe(
          "/opt/atlassian/pipelines/agent/build",
        );
        expect(process.env[BITBUCKET_CLONE_DIR_KEY]).toBeUndefined();
      }),
      Effect.provide(Layer.mergeAll(BunServices.layer, runtimeInfoLayer)),
    );
  });

  it.effect("keeps the shell Bitbucket marker ahead of the project value", () => {
    process.env[BITBUCKET_CLONE_DIR_KEY] = "/real-shell-clone-dir";
    const workdir = tempRoot.current;
    writeDotEnv(workdir, `BITBUCKET_CLONE_DIR=/opt/atlassian/pipelines/agent/build\n`);

    return loadLocalProjectContext(workdir, (message) => new Error(message)).pipe(
      Effect.map((context) => {
        expect(context.projectEnvValues[BITBUCKET_CLONE_DIR_KEY]).toBe("/real-shell-clone-dir");
        expect(process.env[BITBUCKET_CLONE_DIR_KEY]).toBe("/real-shell-clone-dir");
      }),
      Effect.provide(Layer.mergeAll(BunServices.layer, runtimeInfoLayer)),
    );
  });
});
