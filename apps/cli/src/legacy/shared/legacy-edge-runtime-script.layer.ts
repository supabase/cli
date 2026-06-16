import { Effect, FileSystem, Layer, Option, Path } from "effect";
import * as Net from "node:net";

import { LegacyDebugFlag } from "../../shared/legacy/global-flags.ts";
import { LegacyCliConfig } from "../config/legacy-cli-config.service.ts";
import { legacyGetRegistryImageUrl } from "./legacy-docker-registry.ts";
import { LegacyDockerRun } from "./legacy-docker-run.service.ts";
import { legacyResolveEdgeRuntimeImage } from "./legacy-edge-runtime-image.ts";
import { LegacyEdgeRuntimeScriptError } from "./legacy-edge-runtime-script.errors.ts";
import {
  LegacyEdgeRuntimeScript,
  legacyBuildEdgeRuntimeEntrypoint,
  legacyBuildEdgeRuntimeStartCmd,
} from "./legacy-edge-runtime-script.service.ts";

/** `[edge_runtime].deno_version` default (`config.toml` template). 2 → v1.74.1. */
const DEFAULT_DENO_VERSION = 2;

/**
 * Asks the OS for an unused TCP port on 127.0.0.1, like Go's `getFreeHostPort`.
 * On failure the caller drops the `--port` flag (Go preserves prior behaviour),
 * so this resolves to `None` rather than failing the whole run.
 */
const allocateFreeHostPort = Effect.callback<Option.Option<number>>((resume) => {
  const server = Net.createServer();
  server.once("error", () => resume(Effect.succeed(Option.none())));
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    server.close(() => resume(Effect.succeed(port > 0 ? Option.some(port) : Option.none())));
  });
});

/**
 * Real `LegacyEdgeRuntimeScript`: runs the Deno program in the edge-runtime
 * container via `LegacyDockerRun.runCapture`, overriding the image entrypoint
 * with `sh -c <heredoc>` (Go's `RunEdgeRuntimeScript`). The image is resolved
 * once at construction; a fresh free port is allocated per run.
 *
 * NOTE: `deno_version` is assumed default (2). Reading `[edge_runtime]
 * .deno_version` from config is a follow-up if a non-default project ever runs
 * declarative commands. The non-zero-exit message string is approximated from
 * the docker exit code and should be golden-verified against the Go binary.
 */
export const legacyEdgeRuntimeScriptLayer = Layer.effect(
  LegacyEdgeRuntimeScript,
  Effect.gen(function* () {
    const docker = yield* LegacyDockerRun;
    const cliConfig = yield* LegacyCliConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const debug = yield* LegacyDebugFlag;
    const image = yield* legacyResolveEdgeRuntimeImage(
      fs,
      path,
      cliConfig.workdir,
      DEFAULT_DENO_VERSION,
    );
    const registryImage = legacyGetRegistryImageUrl(image);

    return LegacyEdgeRuntimeScript.of({
      run: (opts) =>
        Effect.gen(function* () {
          const port = yield* allocateFreeHostPort;
          const startCmd = legacyBuildEdgeRuntimeStartCmd({ port, debug }).join(" ");
          const files = [{ name: "index.ts", content: opts.script }, ...(opts.extraFiles ?? [])];
          const entrypointBody = legacyBuildEdgeRuntimeEntrypoint(files, startCmd);
          const env = { ...opts.env, ...opts.extraEnv };

          const result = yield* docker
            .runCapture({
              image: registryImage,
              entrypoint: Option.some("sh"),
              cmd: ["-c", entrypointBody],
              env,
              binds: opts.binds,
              workingDir: Option.none(),
              securityOpt: [],
              extraHosts: [],
              network: { _tag: "host" },
            })
            // A spawn failure (e.g. Docker not installed) carries no container
            // stderr; wrap it with the caller's prefix like Go's `%s: %w`.
            .pipe(
              Effect.mapError(
                (cause) =>
                  new LegacyEdgeRuntimeScriptError({
                    message: `${opts.errPrefix}: ${cause.message}`,
                  }),
              ),
            );

          // Go ignores the error when stderr reports the runtime tore down its
          // worker after the script completed (the script's output is still
          // valid). Any other non-zero exit is a real failure.
          if (result.exitCode !== 0 && !result.stderr.includes("main worker has been destroyed")) {
            return yield* Effect.fail(
              new LegacyEdgeRuntimeScriptError({
                message: `${opts.errPrefix}: error running container: exit ${result.exitCode}:\n${result.stderr}`,
              }),
            );
          }

          return {
            stdout: new TextDecoder().decode(result.stdout),
            stderr: result.stderr,
          };
        }),
    });
  }),
);
