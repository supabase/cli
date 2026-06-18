import { Effect, FileSystem, Layer, Option, Path } from "effect";
import * as Net from "node:net";

import { LegacyDebugFlag, LegacyNetworkIdFlag } from "../../shared/legacy/global-flags.ts";
import { RuntimeInfo } from "../../shared/runtime/runtime-info.service.ts";
import { LegacyCliConfig } from "../config/legacy-cli-config.service.ts";
import { legacyReadDbToml } from "./legacy-db-config.toml-read.ts";
import { legacyGetRegistryImageUrl } from "./legacy-docker-registry.ts";
import { LegacyDockerRun } from "./legacy-docker-run.service.ts";
import { legacyResolveEdgeRuntimeImage } from "./legacy-edge-runtime-image.ts";
import { LegacyEdgeRuntimeScriptError } from "./legacy-edge-runtime-script.errors.ts";
import {
  LegacyEdgeRuntimeScript,
  legacyBuildEdgeRuntimeEntrypoint,
  legacyBuildEdgeRuntimeStartCmd,
} from "./legacy-edge-runtime-script.service.ts";

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
 * NOTE: the non-zero-exit message string is approximated from the docker exit
 * code and should be golden-verified against the Go binary.
 */
export const legacyEdgeRuntimeScriptLayer = Layer.effect(
  LegacyEdgeRuntimeScript,
  Effect.gen(function* () {
    const docker = yield* LegacyDockerRun;
    const cliConfig = yield* LegacyCliConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const debug = yield* LegacyDebugFlag;
    const networkIdFlag = yield* LegacyNetworkIdFlag;
    const runtimeInfo = yield* RuntimeInfo;
    // Go's `DockerStart` appends `host.docker.internal:host-gateway` to every
    // container's ExtraHosts on Linux only (build-tag `extraHosts` in
    // `apps/cli-go/internal/utils/docker_linux.go:8`; the append at `docker.go:266`
    // is unconditional but the slice is empty on macOS/Windows). The pg-delta
    // container needs it so a `host.docker.internal` local DB host (from
    // SUPABASE_SERVICES_HOSTNAME) resolves inside the container on Linux/dev-container.
    const extraHosts =
      runtimeInfo.platform === "linux" ? ["host.docker.internal:host-gateway"] : [];
    // Read `[edge_runtime] deno_version` so a `deno_version = 1` project runs the
    // `deno1` image, matching Go's config-driven image switch (the resolver applies
    // the version pin first, then the deno1 override). This is the *base*-config
    // value; a caller with a remote-merged config (e.g. `--linked` declarative
    // generate) overrides it per-run via `opts.denoVersion` below.
    const toml = yield* legacyReadDbToml(fs, path, cliConfig.workdir);
    const baseImage = legacyGetRegistryImageUrl(
      yield* legacyResolveEdgeRuntimeImage(fs, path, cliConfig.workdir, toml.denoVersion),
    );

    // Go requests host networking for the edge-runtime container, but `DockerStart`
    // overrides any network mode (host included) with `--network-id` when set
    // (`apps/cli-go/internal/utils/docker.go:267-271`). Mirror the sibling pattern in
    // `db dump` / `gen types` / `test db` so declarative pg-delta runs reach the
    // local stack on custom networks.
    const networkId = Option.getOrUndefined(networkIdFlag);
    const network =
      networkId !== undefined && networkId.length > 0
        ? ({ _tag: "named" as const, name: networkId } as const)
        : ({ _tag: "host" as const } as const);

    return LegacyEdgeRuntimeScript.of({
      run: (opts) =>
        Effect.gen(function* () {
          // Resolve the image per-run only when the caller supplies an effective
          // `deno_version` that differs from the base config (the remote-merged
          // value on `--linked` declarative generate); otherwise reuse the base
          // image resolved once at layer construction.
          const registryImage =
            opts.denoVersion !== undefined && opts.denoVersion !== toml.denoVersion
              ? legacyGetRegistryImageUrl(
                  yield* legacyResolveEdgeRuntimeImage(
                    fs,
                    path,
                    cliConfig.workdir,
                    opts.denoVersion,
                  ),
                )
              : baseImage;
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
              extraHosts,
              network,
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
