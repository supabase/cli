import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { afterEach, describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { useLegacyTempWorkdir } from "../../../tests/helpers/legacy-mocks.ts";
import { legacyLoadLocalProjectContext } from "./legacy-local-project-context.ts";

/**
 * Docker-client env keys `legacyLoadLocalProjectContext` installs from a project `.env`
 * (see its own doc comment) are exactly `legacyIsDockerClientEnvKey`'s allowlist
 * (`db-bootstrap/docker-create-args.ts`) — `DOCKER_HOST` stands in for the whole set here.
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

const tempRoot = useLegacyTempWorkdir("supabase-legacy-project-context-");

describe("legacyLoadLocalProjectContext", () => {
  const previousDockerHost = process.env[DOCKER_HOST_KEY];
  const previousBitbucketCloneDir = process.env[BITBUCKET_CLONE_DIR_KEY];

  afterEach(() => {
    if (previousDockerHost === undefined) delete process.env[DOCKER_HOST_KEY];
    else process.env[DOCKER_HOST_KEY] = previousDockerHost;
    if (previousBitbucketCloneDir === undefined) delete process.env[BITBUCKET_CLONE_DIR_KEY];
    else process.env[BITBUCKET_CLONE_DIR_KEY] = previousBitbucketCloneDir;
  });

  it.effect(
    "installs a project .env's DOCKER_HOST into process.env before resolving hostname, matching Go's godotenv.Load",
    () => {
      delete process.env[DOCKER_HOST_KEY];
      const workdir = tempRoot.current;
      writeDotEnv(workdir, `DOCKER_HOST=tcp://project-dotenv-host:2375\n`);

      return legacyLoadLocalProjectContext(workdir, (message) => new Error(message)).pipe(
        Effect.map(() => {
          expect(process.env[DOCKER_HOST_KEY]).toBe("tcp://project-dotenv-host:2375");
        }),
        Effect.provide(BunServices.layer),
      );
    },
  );

  it.effect(
    "never overrides an already-set DOCKER_HOST, matching godotenv.Load's shell-env-wins semantics",
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
