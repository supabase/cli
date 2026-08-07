import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { afterEach, describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { useLegacyTempWorkdir } from "../../../tests/helpers/legacy-mocks.ts";
import { legacyLoadLocalProjectContext } from "./legacy-local-project-context.ts";

/**
 * `DOCKER_HOST` stands in for the whole Docker-client key set (`legacyIsDockerClientEnvKey`,
 * `db-bootstrap/docker-create-args.ts`) here — `legacyLoadLocalProjectContext` deliberately does
 * NOT install any of these from a project `.env` (see its own doc comment; review:
 * PRRT_kwDOErm0O86WXFqw): Go's Docker connectivity is the package-level
 * `var Docker = NewDocker()` (`apps/cli-go/internal/utils/docker.go:39`), frozen at binary
 * startup, well before `godotenv.Load` ever runs — so a project-dotenv-only override can never
 * reach it, and installing it here would retarget native commands' Docker daemon relative to Go.
 */
const DOCKER_HOST_KEY = "DOCKER_HOST";

/**
 * `BITBUCKET_CLONE_DIR` is installed alongside the Docker-client keys even though it isn't one
 * itself — see `LEGACY_BITBUCKET_CLONE_DIR_ENV_KEY`'s doc comment (review:
 * PRRT_kwDOErm0O86VmHkm) for why this key, unlike `SUPABASE_SERVICES_HOSTNAME`, must reach
 * `process.env` from a project-only dotenv file.
 */
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

const tempRoot = useLegacyTempWorkdir("supabase-legacy-project-context-");

describe("legacyLoadLocalProjectContext", () => {
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
      // Regression (review: PRRT_kwDOErm0O86XHGDL) — `loadProjectConfig`'s own remote merge
      // (`packages/config/src/io.ts`) already installs the matched block's `project_id` at
      // Go's viper override tier before this reads it; letting an unrelated
      // `SUPABASE_PROJECT_ID` win here would resolve the WRONG project id for the shadow's
      // own network id/container labels on a linked `db diff`/`db pull`.
      process.env["SUPABASE_PROJECT_ID"] = "local";
      const ref = "abcdefghijklmnopqrst";
      const workdir = tempRoot.current;
      writeConfigToml(
        workdir,
        ['project_id = "toml-project"', "[remotes.prod]", `project_id = "${ref}"`, ""].join("\n"),
      );

      return legacyLoadLocalProjectContext(workdir, (message) => new Error(message), ref).pipe(
        Effect.map((context) => {
          expect(context.loaded?.appliedRemote).toBe("prod");
          expect(context.projectId).toBe(ref);
        }),
        Effect.provide(BunServices.layer),
      );
    },
  );

  it.effect("still applies SUPABASE_PROJECT_ID when no [remotes.*] block matches the ref", () => {
    process.env["SUPABASE_PROJECT_ID"] = "env-project";
    const ref = "abcdefghijklmnopqrst";
    const workdir = tempRoot.current;
    writeConfigToml(workdir, ['project_id = "toml-project"', ""].join("\n"));

    return legacyLoadLocalProjectContext(workdir, (message) => new Error(message), ref).pipe(
      Effect.map((context) => {
        expect(context.loaded?.appliedRemote).toBeUndefined();
        expect(context.projectId).toBe("env-project");
      }),
      Effect.provide(BunServices.layer),
    );
  });

  it.effect(
    "does NOT install a project .env's DOCKER_HOST into process.env, matching Go's Docker client being frozen at binary startup, before godotenv.Load ever runs",
    () => {
      delete process.env[DOCKER_HOST_KEY];
      const workdir = tempRoot.current;
      writeDotEnv(workdir, `DOCKER_HOST=tcp://project-dotenv-host:2375\n`);

      return legacyLoadLocalProjectContext(workdir, (message) => new Error(message)).pipe(
        Effect.map(() => {
          expect(process.env[DOCKER_HOST_KEY]).toBeUndefined();
        }),
        Effect.provide(BunServices.layer),
      );
    },
  );

  it.effect(
    "leaves an already-set shell DOCKER_HOST untouched regardless of a conflicting project .env value",
    () => {
      process.env[DOCKER_HOST_KEY] = "tcp://real-shell-host:2375";
      const workdir = tempRoot.current;
      writeDotEnv(workdir, `DOCKER_HOST=tcp://project-dotenv-host:2375\n`);

      return legacyLoadLocalProjectContext(workdir, (message) => new Error(message)).pipe(
        Effect.map(() => {
          expect(process.env[DOCKER_HOST_KEY]).toBe("tcp://real-shell-host:2375");
        }),
        Effect.provide(BunServices.layer),
      );
    },
  );

  it.effect(
    "installs a project .env's BITBUCKET_CLONE_DIR into process.env, matching Go's godotenv.Load preceding DockerStart's os.Getenv read",
    () => {
      delete process.env[BITBUCKET_CLONE_DIR_KEY];
      const workdir = tempRoot.current;
      writeDotEnv(workdir, `BITBUCKET_CLONE_DIR=/opt/atlassian/pipelines/agent/build\n`);

      return legacyLoadLocalProjectContext(workdir, (message) => new Error(message)).pipe(
        Effect.map(() => {
          expect(process.env[BITBUCKET_CLONE_DIR_KEY]).toBe("/opt/atlassian/pipelines/agent/build");
        }),
        Effect.provide(BunServices.layer),
      );
    },
  );

  it.effect(
    "never overrides an already-set BITBUCKET_CLONE_DIR, matching godotenv.Load's shell-env-wins semantics",
    () => {
      process.env[BITBUCKET_CLONE_DIR_KEY] = "/real-shell-clone-dir";
      const workdir = tempRoot.current;
      writeDotEnv(workdir, `BITBUCKET_CLONE_DIR=/opt/atlassian/pipelines/agent/build\n`);

      return legacyLoadLocalProjectContext(workdir, (message) => new Error(message)).pipe(
        Effect.map(() => {
          expect(process.env[BITBUCKET_CLONE_DIR_KEY]).toBe("/real-shell-clone-dir");
        }),
        Effect.provide(BunServices.layer),
      );
    },
  );
});
