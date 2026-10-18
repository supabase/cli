import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { useTempWorkdir } from "../../tests/helpers/command-mocks.ts";
import { mockOutput, processEnvLayer } from "../../tests/helpers/mocks.ts";
import { CliConfigFlagInputs, makeCliConfigFlagInputs } from "../config/cli-config-flags.ts";
import { cliConfigValuesLayer } from "../config/cli-config-values.layer.ts";
import { runtimeInfoLayer } from "../shared/runtime/runtime-info.layer.ts";
import { loadLocalResolvedConfigContext } from "./resolved-config-context.ts";

const tempRoot = useTempWorkdir("supabase-resolved-config-context-");

function writeProjectEnv(workdir: string, contents: string): void {
  const supabaseDir = join(workdir, "supabase");
  mkdirSync(supabaseDir, { recursive: true });
  writeFileSync(join(supabaseDir, ".env"), contents);
}

/** Runs against a shell environment of exactly `env`, with the real config service and an empty Docker config dir. */
const layerWithShellEnv = (workdir: string, env: Readonly<Record<string, string>> = {}) =>
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
      processEnvLayer({ DOCKER_CONFIG: join(workdir, "docker-config"), ...env }),
    ),
  );

describe("loadLocalResolvedConfigContext hostname", () => {
  it.effect("reads SUPABASE_SERVICES_HOSTNAME from a project .env", () => {
    const workdir = tempRoot.current;
    writeProjectEnv(workdir, "SUPABASE_SERVICES_HOSTNAME=dotenv-host\n");

    return loadLocalResolvedConfigContext(workdir).pipe(
      Effect.map((context) => {
        expect(context.hostname).toBe("dotenv-host");
      }),
      Effect.provide(layerWithShellEnv(workdir)),
    );
  });

  it.effect("prefers a shell SUPABASE_SERVICES_HOSTNAME over a project .env", () => {
    const workdir = tempRoot.current;
    writeProjectEnv(workdir, "SUPABASE_SERVICES_HOSTNAME=dotenv-host\n");

    return loadLocalResolvedConfigContext(workdir).pipe(
      Effect.map((context) => {
        expect(context.hostname).toBe("shell-host");
      }),
      Effect.provide(layerWithShellEnv(workdir, { SUPABASE_SERVICES_HOSTNAME: "shell-host" })),
    );
  });

  it.effect("ignores a project .env DOCKER_HOST when discovering the daemon", () => {
    const workdir = tempRoot.current;
    writeProjectEnv(workdir, "DOCKER_HOST=tcp://x:2375\n");

    return loadLocalResolvedConfigContext(workdir).pipe(
      Effect.map((context) => {
        expect(context.hostname).toBe("127.0.0.1");
      }),
      Effect.provide(layerWithShellEnv(workdir)),
    );
  });

  it.effect("takes the daemon host from a shell DOCKER_HOST", () => {
    const workdir = tempRoot.current;
    writeProjectEnv(workdir, "DOCKER_HOST=tcp://project-dotenv-host:2375\n");

    return loadLocalResolvedConfigContext(workdir).pipe(
      Effect.map((context) => {
        expect(context.hostname).toBe("shell-daemon-host");
      }),
      Effect.provide(layerWithShellEnv(workdir, { DOCKER_HOST: "tcp://shell-daemon-host:2375" })),
    );
  });
});
