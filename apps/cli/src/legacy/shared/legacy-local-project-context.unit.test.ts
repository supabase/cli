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

function writeDotEnv(workdir: string, contents: string): void {
  mkdirSync(workdir, { recursive: true });
  writeFileSync(join(workdir, ".env"), contents);
}

const tempRoot = useLegacyTempWorkdir("supabase-legacy-project-context-");

describe("legacyLoadLocalProjectContext", () => {
  const previousDockerHost = process.env[DOCKER_HOST_KEY];

  afterEach(() => {
    if (previousDockerHost === undefined) delete process.env[DOCKER_HOST_KEY];
    else process.env[DOCKER_HOST_KEY] = previousDockerHost;
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
});
