import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { Crypto, Effect, FileSystem, Path, Stream } from "effect";
import { volumeNameFor } from "../src/storage/DockerDatabaseStorage.ts";
import { cleanupDockerRoot } from "./docker-cleanup.ts";

/** Runs a Docker CLI command and returns its combined output and exit code. */
export const runDocker = Effect.fn("DockerTest.runDocker")((args: ReadonlyArray<string>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const child = yield* spawner.spawn(
        ChildProcess.make("docker", args, { stdout: "pipe", stderr: "pipe" }),
      );
      const [stdout, stderr, code] = yield* Effect.all(
        [
          Stream.mkString(Stream.decodeText(child.stdout)),
          Stream.mkString(Stream.decodeText(child.stderr)),
          child.exitCode,
        ],
        { concurrency: "unbounded" },
      );
      return { output: `${stdout}${stderr}`, code: Number(code) };
    }),
  ),
);

/** Allocates the documented state-root layout used by Docker database fixtures. */
export const makeDockerDatabaseRoot = Effect.fn("DockerTest.makeDatabaseRoot")(
  (prefix: string, stackId = "catalog-test") =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const crypto = yield* Crypto.Crypto;
      const temporaryRoot = yield* fs.makeTempDirectoryScoped({ prefix });
      const root = `${temporaryRoot}/state/${stackId}/data`;
      yield* fs.makeDirectory(root, { recursive: true });
      const stateRoot = yield* fs.realPath(path.dirname(path.dirname(root)));
      const daemon = yield* runDocker(["info", "--format", "{{.ID}}"]).pipe(
        Effect.flatMap((result) =>
          result.code === 0
            ? Effect.succeed(result.output.trim())
            : Effect.die(`Docker info failed: ${result.output}`),
        ),
      );
      const stateDigest = yield* crypto
        .digest("SHA-256", new TextEncoder().encode(`${stateRoot}\0${daemon}`))
        .pipe(
          Effect.map((bytes) =>
            Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(""),
          ),
        );
      const volume = volumeNameFor(stateDigest);
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          const inspected = yield* runDocker([
            "volume",
            "inspect",
            "--format",
            '{{ index .Labels "com.supabase.stack-managed" }}|{{ index .Labels "com.supabase.stack-state-root" }}',
            volume,
          ]);
          if (inspected.code !== 0) {
            if (/no such volume|not found/iu.test(inspected.output)) return;
            return yield* Effect.die(`Docker volume inspect failed: ${inspected.output}`);
          }
          const [managed, labeledState] = inspected.output.trim().split("|");
          if (managed !== "true" || labeledState !== stateDigest)
            return yield* Effect.die("Docker fixture volume identity did not match its state root");
          const removed = yield* runDocker(["volume", "rm", volume]);
          if (removed.code !== 0 && !/no such volume|not found/iu.test(removed.output))
            return yield* Effect.die(`Docker volume cleanup failed: ${removed.output}`);
        }).pipe(
          Effect.andThen(
            Effect.gen(function* () {
              if (yield* fs.exists(root)) yield* cleanupDockerRoot(root);
            }),
          ),
          Effect.catchCause(Effect.die),
        ),
      );
      return root;
    }),
);
