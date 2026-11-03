import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path } from "effect";

import { useTempWorkdir } from "../../tests/helpers/command-mocks.ts";
import { mockOutput, processEnvLayer } from "../../tests/helpers/mocks.ts";
import { CliConfigFlagInputs, makeCliConfigFlagInputs } from "../config/cli-config-flags.ts";
import { cliConfigValuesLayer } from "../config/cli-config-values.layer.ts";
import { runtimeInfoLayer } from "../shared/runtime/runtime-info.layer.ts";
import { loadLocalResolvedConfigContext } from "./resolved-config-context.ts";

const tempRoot = useTempWorkdir("supabase-resolved-config-context-");

const writeProjectEnv = (workdir: string, contents: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const supabaseDir = path.join(workdir, "supabase");
    yield* fs.makeDirectory(supabaseDir, { recursive: true });
    yield* fs.writeFileString(path.join(supabaseDir, ".env"), contents);
  }).pipe(Effect.provide(BunServices.layer));

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
      processEnvLayer({ DOCKER_CONFIG: `${workdir}/docker-config`, ...env }),
    ),
  );

describe("loadLocalResolvedConfigContext hostname", () => {
  it.effect("reads SUPABASE_SERVICES_HOSTNAME from a project .env", () =>
    Effect.gen(function* () {
      const workdir = tempRoot.current;
      yield* writeProjectEnv(workdir, "SUPABASE_SERVICES_HOSTNAME=dotenv-host\n");

      return yield* loadLocalResolvedConfigContext(workdir).pipe(
        Effect.map((context) => {
          expect(context.hostname).toBe("dotenv-host");
        }),
        Effect.provide(layerWithShellEnv(workdir)),
      );
    }),
  );

  it.effect("prefers a shell SUPABASE_SERVICES_HOSTNAME over a project .env", () =>
    Effect.gen(function* () {
      const workdir = tempRoot.current;
      yield* writeProjectEnv(workdir, "SUPABASE_SERVICES_HOSTNAME=dotenv-host\n");

      return yield* loadLocalResolvedConfigContext(workdir).pipe(
        Effect.map((context) => {
          expect(context.hostname).toBe("shell-host");
        }),
        Effect.provide(layerWithShellEnv(workdir, { SUPABASE_SERVICES_HOSTNAME: "shell-host" })),
      );
    }),
  );

  it.effect("ignores a project .env DOCKER_HOST when discovering the daemon", () =>
    Effect.gen(function* () {
      const workdir = tempRoot.current;
      yield* writeProjectEnv(workdir, "DOCKER_HOST=tcp://x:2375\n");

      return yield* loadLocalResolvedConfigContext(workdir).pipe(
        Effect.map((context) => {
          expect(context.hostname).toBe("127.0.0.1");
        }),
        Effect.provide(layerWithShellEnv(workdir)),
      );
    }),
  );

  it.effect("takes the daemon host from a shell DOCKER_HOST", () =>
    Effect.gen(function* () {
      const workdir = tempRoot.current;
      yield* writeProjectEnv(workdir, "DOCKER_HOST=tcp://project-dotenv-host:2375\n");

      return yield* loadLocalResolvedConfigContext(workdir).pipe(
        Effect.map((context) => {
          expect(context.hostname).toBe("shell-daemon-host");
        }),
        Effect.provide(layerWithShellEnv(workdir, { DOCKER_HOST: "tcp://shell-daemon-host:2375" })),
      );
    }),
  );
});
