import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Context, Deferred, Effect, Fiber, FileSystem, Layer, Path, Ref } from "effect";
import { TestClock } from "effect/testing";
import { initialization } from "../Commands.ts";
import {
  makeArtifactStore,
  type ArtifactRequest,
  type ArtifactSource,
} from "../preparation/ArtifactStore.ts";
import { PreparationError } from "../preparation/Errors.ts";
import type { StackCredentials } from "../State.ts";
import * as CommandRunner from "./CommandRunner.ts";

const target =
  process.platform === "darwin" && process.arch === "arm64"
    ? "darwin-arm64"
    : process.platform === "linux" && process.arch === "x64"
      ? "linux-amd64"
      : process.platform === "linux" && process.arch === "arm64"
        ? "linux-arm64"
        : undefined;

const prepareAuthArtifact = Effect.fn(function* (cacheRoot: string, script: string) {
  if (target === undefined) return yield* Effect.fail("Unsupported test platform");
  const fs = yield* FileSystem.FileSystem;
  const request: ArtifactRequest = {
    key: `slim-services/auth/v2.196.0/${target}`,
    requiredRuntimePaths: ["bin/auth"],
    executablePath: "bin/auth",
  };
  const source: ArtifactSource = {
    checksum: () => Effect.succeed("0".repeat(64)),
    materialize: (_request, destination) =>
      Effect.gen(function* () {
        yield* fs.makeDirectory(`${destination}/bin`, { recursive: true });
        yield* fs.writeFileString(`${destination}/bin/auth`, script);
        yield* fs.chmod(`${destination}/bin/auth`, 0o755);
      }).pipe(
        Effect.mapError(
          (cause) =>
            new PreparationError({
              message: `Unable to write Auth command fixture: ${cause.message}`,
              cause,
            }),
        ),
      ),
  };
  const store = yield* makeArtifactStore({ cacheRoot, source });
  yield* store.prepare(request);
});

const makeRunner = Effect.fn(function* (root: string, cacheRoot: string) {
  const layer = CommandRunner.layer({
    stackId: "initialization-command-test",
    root,
    cacheRoot,
    runtime: "native",
  }).pipe(Layer.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp)));
  return Context.get(yield* Layer.build(layer), CommandRunner.Service);
});

const credentials: StackCredentials = {
  jwtSecret: "fixture-stack-jwt-secret-with-more-than-32-characters",
  postgresRootKey: "fixture-postgres-root-key",
  databasePassword: "fixture-database-password",
  publishableKey: "fixture-publishable-key",
  secretKey: "fixture-secret-key",
  anonKey: "fixture-anon-key",
  serviceRoleKey: "fixture-service-role-key",
  jwks: "fixture-jwks",
  gotrueJwtKeys: "fixture-gotrue-jwt-keys",
  remoteJwks: "fixture-remote-jwks",
  anonKeyIsOverride: false,
  serviceRoleKeyIsOverride: false,
};

it.live.skipIf(target === undefined || process.platform === "win32")(
  "reports bounded stdout and stderr when an initialization command fails",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "initialization-command-failure-",
        });
        const cacheRoot = path.join(root, "cache");
        yield* prepareAuthArtifact(
          cacheRoot,
          `#!${process.execPath}\nfor (let index = 0; index < 30; index++) { console.log("x".repeat(1500) + " stdout-tail-" + index); console.error("y".repeat(1500) + " stderr-tail-" + index); }\nconsole.error("jwt=" + process.env.GOTRUE_JWT_SECRET);\nconsole.error("keys=" + process.env.GOTRUE_JWT_KEYS);\nconsole.error("fixture migration failure");\nprocess.exit(7);\n`,
        );
        const runner = yield* makeRunner(root, cacheRoot);
        const error = yield* runner
          .run({
            command: initialization.auth({
              version: "v2.196.0",
              databaseUrl: "postgresql://invalid:invalid@127.0.0.1:1/postgres",
            }),
            credentials,
            stdout: () => Effect.void,
            stderr: () => Effect.void,
          })
          .pipe(Effect.flip);

        expect(error.message).toContain("auth.initialize exited with code 7");
        expect(error.message).toContain("stdout-tail-29");
        expect(error.message).not.toContain("stdout-tail-0");
        expect(error.message).toContain("stderr-tail-29");
        expect(error.message).not.toContain("stderr-tail-0");
        expect(error.message).toContain("fixture migration failure");
        expect(error.message).toContain(`jwt=${credentials.jwtSecret}`);
        expect(error.message).toContain(`keys=${credentials.gotrueJwtKeys}`);
        expect(error.message.length).toBeLessThan(45_000);
      }).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
    ),
);

it.live.skipIf(target === undefined || process.platform === "win32")(
  "interrupts a running initialization command and completes its cleanup",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "initialization-command-cancel-",
        });
        const cacheRoot = path.join(root, "cache");
        yield* prepareAuthArtifact(
          cacheRoot,
          `#!${process.execPath}\nconsole.log("command started " + process.pid);\nsetInterval(() => {}, 1000);\n`,
        );
        const runner = yield* makeRunner(root, cacheRoot);
        const started = yield* Deferred.make<void>();
        const pid = yield* Ref.make<string | undefined>(undefined);
        const command = yield* runner
          .run({
            command: initialization.auth({
              version: "v2.196.0",
              databaseUrl: "postgresql://invalid:invalid@127.0.0.1:1/postgres",
            }),
            credentials,
            stdout: (bytes) =>
              Effect.gen(function* () {
                const match = /command started (\d+)/.exec(new TextDecoder().decode(bytes));
                if (match?.[1] !== undefined) {
                  yield* Ref.set(pid, match[1]);
                  yield* Deferred.succeed(started, undefined);
                }
              }),
            stderr: () => Effect.void,
          })
          .pipe(Effect.forkScoped);

        yield* Deferred.await(started);
        yield* Fiber.interrupt(command);

        const childPid = yield* Ref.get(pid);
        if (childPid === undefined)
          return yield* Effect.fail("Command process id was not observed");
        const childStillRunning = yield* Effect.sync(() => {
          try {
            process.kill(Number(childPid), 0);
            return true;
          } catch {
            return false;
          }
        });
        const jobs = yield* fs.readDirectory(path.join(root, "jobs"));
        expect(childStillRunning).toBe(false);
        expect(jobs).toHaveLength(0);
      }).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
    ),
);

it.effect.skipIf(target === undefined || process.platform === "win32")(
  "reports bounded output when an initialization command times out",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "initialization-command-timeout-",
        });
        const cacheRoot = path.join(root, "cache");
        yield* prepareAuthArtifact(
          cacheRoot,
          `#!${process.execPath}\nconsole.error("migration still running " + process.pid);\nsetInterval(() => {}, 1000);\n`,
        );
        const runner = yield* makeRunner(root, cacheRoot);
        const started = yield* Deferred.make<void>();
        const pid = yield* Ref.make<string | undefined>(undefined);
        const command = yield* runner
          .run({
            command: initialization.auth({
              version: "v2.196.0",
              databaseUrl: "postgresql://invalid:invalid@127.0.0.1:1/postgres",
            }),
            credentials,
            stdout: () => Effect.void,
            stderr: (bytes) =>
              Effect.gen(function* () {
                const match = /migration still running (\d+)/.exec(new TextDecoder().decode(bytes));
                if (match?.[1] !== undefined) {
                  yield* Ref.set(pid, match[1]);
                  yield* Deferred.succeed(started, undefined);
                }
              }),
          })
          .pipe(Effect.forkScoped);

        yield* Deferred.await(started);
        yield* TestClock.adjust("60 seconds");
        const error = yield* Fiber.join(command).pipe(Effect.flip);

        expect(error.message).toContain("auth.initialize timed out after 60 seconds");
        expect(error.message).toContain("migration still running");
        const childPid = yield* Ref.get(pid);
        if (childPid === undefined)
          return yield* Effect.fail("Command process id was not observed");
        const childStillRunning = yield* Effect.sync(() => {
          try {
            process.kill(Number(childPid), 0);
            return true;
          } catch {
            return false;
          }
        });
        expect(childStillRunning).toBe(false);
      }).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
    ),
);
