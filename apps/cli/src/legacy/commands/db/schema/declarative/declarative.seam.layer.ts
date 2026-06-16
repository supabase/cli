import { Effect, Layer, Option, Stream } from "effect";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";

import { LegacyNetworkIdFlag } from "../../../../../shared/legacy/global-flags.ts";
import { resolveBinary } from "../../../../../shared/legacy/go-proxy.layer.ts";
import { LegacyCliConfig } from "../../../../config/legacy-cli-config.service.ts";
import { LegacyDeclarativeShadowDbError } from "./declarative.errors.ts";
import { LegacyDeclarativeSeam } from "./declarative.seam.service.ts";

/**
 * Real `LegacyDeclarativeSeam`: runs the bundled `supabase-go`'s hidden
 * `db schema declarative __catalog --mode <m> --experimental` with stdout piped
 * (the catalog path) and stderr inherited (shadow-DB progress / image pulls).
 * The Go binary is resolved exactly like `LegacyGoProxy` (`resolveBinary`).
 */
export const legacyDeclarativeSeamLayer = Layer.effect(
  LegacyDeclarativeSeam,
  Effect.gen(function* () {
    const cliConfig = yield* LegacyCliConfig;
    const networkId = yield* LegacyNetworkIdFlag;
    const spawner = yield* ChildProcessSpawner;
    const resolved = resolveBinary();

    return LegacyDeclarativeSeam.of({
      exportCatalog: ({ mode, noCache }) =>
        Effect.scoped(
          Effect.gen(function* () {
            if (!("found" in resolved)) {
              return yield* Effect.fail(
                new LegacyDeclarativeShadowDbError({
                  message:
                    "Could not find the supabase-go binary required to provision the shadow database.",
                }),
              );
            }
            const args = [
              "db",
              "schema",
              "declarative",
              "__catalog",
              "--mode",
              mode,
              "--experimental",
              ...(noCache ? ["--no-cache"] : []),
              // The shadow DB is provisioned via DockerStart, which reads the root
              // --network-id from viper (`apps/cli-go/internal/utils/docker.go:267-271`).
              // Forward it on the seam argv so catalog/shadow containers land on the
              // same custom network as the pg-delta containers (LegacyGoProxy forwards
              // it the same way).
              ...(Option.isSome(networkId) ? ["--network-id", networkId.value] : []),
            ];
            const command = ChildProcess.make(resolved.found, args, {
              cwd: cliConfig.workdir,
              stdin: "inherit",
              stdout: "pipe",
              stderr: "inherit",
              extendEnv: true,
              detached: false,
            });
            const handle = yield* spawner.spawn(command).pipe(
              Effect.mapError(
                () =>
                  new LegacyDeclarativeShadowDbError({
                    message: "failed to run the shadow-database provisioner (supabase-go).",
                  }),
              ),
            );
            const chunks: Array<Uint8Array> = [];
            yield* Stream.runForEach(handle.stdout, (chunk) =>
              Effect.sync(() => {
                chunks.push(chunk);
              }),
            ).pipe(Effect.mapError(() => failure()));
            const exitCode = yield* handle.exitCode.pipe(Effect.mapError(() => failure()));
            if (exitCode !== 0) {
              return yield* Effect.fail(failure(exitCode));
            }
            const total = chunks.reduce((size, chunk) => size + chunk.length, 0);
            const bytes = new Uint8Array(total);
            let offset = 0;
            for (const chunk of chunks) {
              bytes.set(chunk, offset);
              offset += chunk.length;
            }
            return new TextDecoder().decode(bytes).trim();
          }),
        ),
      execInherit: (args) =>
        Effect.gen(function* () {
          if (!("found" in resolved)) {
            return yield* Effect.fail(
              new LegacyDeclarativeShadowDbError({
                message: "Could not find the supabase-go binary.",
              }),
            );
          }
          const command = ChildProcess.make(resolved.found, args, {
            cwd: cliConfig.workdir,
            stdin: "inherit",
            stdout: "inherit",
            stderr: "inherit",
            extendEnv: true,
            detached: false,
          });
          return yield* spawner
            .exitCode(command)
            .pipe(
              Effect.mapError(
                () => new LegacyDeclarativeShadowDbError({ message: "failed to run supabase-go." }),
              ),
            );
        }),
    });
  }),
);

const failure = (exitCode?: number) =>
  new LegacyDeclarativeShadowDbError({
    message:
      exitCode === undefined
        ? "failed to provision the shadow database."
        : `failed to provision the shadow database: exit ${exitCode}`,
  });
