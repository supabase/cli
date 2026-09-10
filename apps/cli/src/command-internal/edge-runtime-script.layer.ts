import { Effect, FileSystem, Layer, Option, Path } from "effect";
import * as Net from "node:net";

import { DebugFlag, NetworkIdFlag } from "./global-flags.ts";
import { RuntimeInfo } from "../shared/runtime/runtime-info.service.ts";
import { CommandSettings } from "../config/command-settings.service.ts";
import { readDbToml } from "./db-config.toml-read.ts";
import { getRegistryImageUrl } from "./docker-registry.ts";
import { DockerRun } from "./docker-run.service.ts";
import { resolveEdgeRuntimeImage } from "./edge-runtime-image.ts";
import { EdgeRuntimeScriptError } from "./edge-runtime-script.errors.ts";
import {
  EDGE_RUNTIME_SCRIPT_ERROR_SENTINEL,
  EdgeRuntimeScript,
  buildEdgeRuntimeEntrypoint,
  buildEdgeRuntimeStartCmd,
} from "./edge-runtime-script.service.ts";

/**
 * Asks the OS for an unused TCP port on 127.0.0.1. Resolves to `None` on failure so the caller
 * can drop the `--port` flag instead of failing the whole run.
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
 * Real `EdgeRuntimeScript`: runs the Deno program in the edge-runtime container via
 * `DockerRun.runCapture`, overriding the image entrypoint with `sh -c <heredoc>`. The image
 * (from the caller's effective `deno_version`) and a fresh free port are resolved per run, so
 * layer construction reads no config.
 *
 * NOTE: the non-zero-exit message string is approximated from the docker exit code and may not
 * exactly match real edge-runtime output.
 */
export const edgeRuntimeScriptLayer = Layer.effect(
  EdgeRuntimeScript,
  Effect.gen(function* () {
    const docker = yield* DockerRun;
    const cliSettings = yield* CommandSettings;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const debug = yield* DebugFlag;
    const networkIdFlag = yield* NetworkIdFlag;
    const runtimeInfo = yield* RuntimeInfo;
    // The pg-delta container needs `host.docker.internal:host-gateway` on Linux only, so a
    // `host.docker.internal` local DB host (from SUPABASE_SERVICES_HOSTNAME) resolves inside the
    // container on Linux/dev-container; Docker Desktop already provides this on macOS/Windows.
    const extraHosts =
      runtimeInfo.platform === "linux" ? ["host.docker.internal:host-gateway"] : [];

    // Host networking is the default so pg-delta reaches the local stack directly, but an
    // explicit `--network-id` overrides it — matching the same pattern used by
    // `db dump`/`gen types`/`test db`.
    const networkId = Option.getOrUndefined(networkIdFlag);
    const network =
      networkId !== undefined && networkId.length > 0
        ? ({ _tag: "named" as const, name: networkId } as const)
        : ({ _tag: "host" as const } as const);

    return EdgeRuntimeScript.of({
      run: (opts) =>
        Effect.gen(function* () {
          // Resolved per-run, not at layer acquisition, so merely composing this runtime never
          // validates the base config before a linked ref is known. Every pg-delta/migra caller
          // passes `opts.denoVersion`, so this read only runs as a defensive fallback.
          //
          // `workdir` follows the same pattern: `cliSettings.workdir` is fixed at layer-build
          // time, before a command's own `process.chdir` runs, so callers pass their own
          // directory to keep the image-pin lookup and config fallback consistent with the rest
          // of the run.
          const workdir = opts.workdir ?? cliSettings.workdir;
          const denoVersion =
            opts.denoVersion ??
            (yield* readDbToml(fs, path, workdir).pipe(
              Effect.mapError((error) => new EdgeRuntimeScriptError({ message: error.message })),
            )).denoVersion;
          const registryImage = getRegistryImageUrl(
            yield* resolveEdgeRuntimeImage(fs, path, workdir, denoVersion),
          );
          const port = yield* allocateFreeHostPort;
          const startCmd = buildEdgeRuntimeStartCmd({ port, debug }).join(" ");
          const files = [{ name: "index.ts", content: opts.script }];
          const entrypointBody = buildEdgeRuntimeEntrypoint(files, startCmd);
          const env = opts.env;

          const result = yield* docker
            .runCapture({
              image: registryImage,
              entrypoint: Option.some("sh"),
              cmd: ["-c", entrypointBody],
              env,
              binds: opts.binds,
              workingDir: Option.none(),
              // SELinux-enforcing hosts (e.g. Fedora + rootless Podman) block the container from
              // reading CLI-generated files under the `/workspace` bind, like the pg-delta CA
              // bundle. Disable label separation for this helper container instead of relabeling
              // the user's project files — same as `db test`'s pg_prove run; Bitbucket CI clears
              // it via `applyBitbucketDockerFilter`.
              securityOpt: ["label:disable"],
              extraHosts,
              network,
            })
            // A spawn failure (e.g. Docker not installed) carries no container stderr, so wrap
            // it with the caller's prefix. Threading the docker discriminant keeps a
            // daemon-down/registry-pull failure from being misclassified as user SQL.
            .pipe(
              Effect.mapError(
                (cause) =>
                  new EdgeRuntimeScriptError({
                    message: `${opts.errPrefix}: ${cause.message}`,
                    docker:
                      cause.reason === "spawn" || cause.daemonDown
                        ? "daemon"
                        : cause.reason === "pull"
                          ? "pull"
                          : "inspect",
                  }),
              ),
            );

          // A non-zero exit is ignored when stderr reports the runtime tore down its worker
          // after the script completed — the script's output is still valid. Any other
          // non-zero exit is real.
          if (result.exitCode !== 0 && !result.stderr.includes("main worker has been destroyed")) {
            return yield* Effect.fail(
              new EdgeRuntimeScriptError({
                message: `${opts.errPrefix}: error running container: exit ${result.exitCode}:\n${result.stderr}`,
              }),
            );
          }

          // A script crash is otherwise masked by the "main worker has been destroyed"
          // suppression above, since the templates force the worker to exit by throwing. The
          // sentinel — printed only by the templates' catch blocks — marks that real failure so
          // the collected stderr reaches the user instead of looking like an empty diff.
          if (result.stderr.includes(EDGE_RUNTIME_SCRIPT_ERROR_SENTINEL)) {
            return yield* Effect.fail(
              new EdgeRuntimeScriptError({
                message: `${opts.errPrefix}: error running script:\n${result.stderr}`,
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
