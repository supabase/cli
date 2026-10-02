import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { Crypto, Effect, FileSystem, Stream } from "effect";
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

/** Computes a state root's Docker volume identity digest: this host's daemon plus the root. */
const stateDigestFor = Effect.fn("DockerTest.stateDigestFor")((stateRoot: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const crypto = yield* Crypto.Crypto;
    const resolvedStateRoot = yield* fs.realPath(stateRoot);
    const daemon = yield* runDocker(["info", "--format", "{{.ID}}"]).pipe(
      Effect.flatMap((result) =>
        result.code === 0
          ? Effect.succeed(result.output.trim())
          : Effect.die(`Docker info failed: ${result.output}`),
      ),
    );
    return yield* crypto
      .digest("SHA-256", new TextEncoder().encode(`${resolvedStateRoot}\0${daemon}`))
      .pipe(
        Effect.map((bytes) =>
          Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(""),
        ),
      );
  }),
);

/**
 * Removes the Docker volume a state root owns: the shared snapshot cache of every stack under it.
 * Call only once that root's owner is sure no sibling stack still needs it. Tolerates an
 * already-removed volume; any other failure, including one still in use, dies.
 */
export const removeManagedVolume = Effect.fn("DockerTest.removeManagedVolume")(
  (stateRoot: string) =>
    Effect.gen(function* () {
      const stateDigest = yield* stateDigestFor(stateRoot);
      const volume = volumeNameFor(stateDigest);
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
    }),
);

/**
 * Allocates the documented state-root layout used by Docker database fixtures. Defaults to a
 * fresh private root, whose finalizer owns and removes its volume. Pass `stateRoot` to place the
 * data root under an existing one (such as the shared integration state root) instead: that root's
 * owner removes the volume once, so this finalizer only cleans its own data leaf.
 */
export const makeDockerDatabaseRoot = Effect.fn("DockerTest.makeDatabaseRoot")(
  (prefix: string, stackId = "catalog-test", options: { readonly stateRoot?: string } = {}) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const registryRoot =
        options.stateRoot === undefined
          ? `${yield* fs.makeTempDirectoryScoped({ prefix })}/state`
          : options.stateRoot;
      const root = `${registryRoot}/${stackId}/data`;
      yield* fs.makeDirectory(root, { recursive: true });
      yield* Effect.addFinalizer(() =>
        (options.stateRoot === undefined ? removeManagedVolume(registryRoot) : Effect.void).pipe(
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
