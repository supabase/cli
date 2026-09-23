import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Path,
  Scope,
  Sink,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { copyDirectory } from "./DirectoryCopy.ts";

const run = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path | Scope.Scope
  >,
) => Effect.scoped(effect).pipe(Effect.provide(NodeServices.layer));

describe("copyDirectory", () => {
  it.live("copies nested files and preserves modes", () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "directory-copy-" });
        const source = path.join(root, "source");
        const destination = path.join(root, "destination");
        const nested = path.join(source, "nested");
        yield* fs.makeDirectory(nested, { recursive: true });
        yield* fs.writeFileString(path.join(source, "root.txt"), "root\n");
        yield* fs.writeFileString(path.join(nested, "child.txt"), "child\n");
        if (process.platform !== "win32") {
          yield* fs.chmod(path.join(source, "root.txt"), 0o640);
          yield* fs.chmod(nested, 0o750);
        }

        yield* copyDirectory(source, destination);

        expect(yield* fs.readFileString(path.join(destination, "root.txt"))).toBe("root\n");
        expect(yield* fs.readFileString(path.join(destination, "nested", "child.txt"))).toBe(
          "child\n",
        );
        yield* fs.writeFileString(path.join(destination, "root.txt"), "destination\n");
        yield* fs.writeFileString(path.join(source, "nested", "child.txt"), "source\n");
        expect(yield* fs.readFileString(path.join(source, "root.txt"))).toBe("root\n");
        expect(yield* fs.readFileString(path.join(destination, "nested", "child.txt"))).toBe(
          "child\n",
        );
        if (process.platform !== "win32") {
          expect(Number((yield* fs.stat(path.join(destination, "root.txt"))).mode) & 0o777).toBe(
            0o640,
          );
          expect(Number((yield* fs.stat(path.join(destination, "nested"))).mode) & 0o777).toBe(
            0o750,
          );
        }
      }),
    ),
  );

  it.live("rejects symlinks and leaves the destination absent", () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "directory-copy-link-" });
        const source = path.join(root, "source");
        const destination = path.join(root, "destination");
        yield* fs.makeDirectory(source);
        yield* fs.writeFileString(path.join(root, "outside.txt"), "outside\n");
        const symlink = yield* fs
          .symlink(path.join(root, "outside.txt"), path.join(source, "link.txt"))
          .pipe(Effect.exit);
        if (Exit.isFailure(symlink)) {
          if (
            process.platform === "win32" &&
            /(?:EPERM|EACCES|privilege)/iu.test(String(symlink.cause))
          )
            return;
          return yield* Effect.failCause(symlink.cause);
        }

        const result = yield* copyDirectory(source, destination).pipe(Effect.exit);

        expect(Exit.isFailure(result)).toBe(true);
        expect(yield* fs.exists(destination)).toBe(false);
      }),
    ),
  );

  it.live("rejects a file source and leaves the destination absent", () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "directory-copy-file-" });
        const source = path.join(root, "source.txt");
        const destination = path.join(root, "destination");
        yield* fs.writeFileString(source, "file\n");

        const result = yield* copyDirectory(source, destination).pipe(Effect.exit);

        expect(Exit.isFailure(result)).toBe(true);
        expect(yield* fs.exists(destination)).toBe(false);
      }),
    ),
  );

  it.live("rejects an existing destination", () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "directory-copy-existing-" });
        const source = `${root}/source`;
        const destination = `${root}/destination`;
        yield* fs.makeDirectory(source);
        yield* fs.makeDirectory(destination);
        const result = yield* copyDirectory(source, destination).pipe(Effect.exit);
        expect(Exit.isFailure(result)).toBe(true);
      }),
    ),
  );

  it.live("copies through read-only source directories before preserving their modes", () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "directory-copy-readonly-" });
        const source = path.join(root, "source");
        const nested = path.join(source, "nested");
        const destination = path.join(root, "destination");
        yield* fs.makeDirectory(nested, { recursive: true });
        yield* fs.writeFileString(path.join(nested, "child.txt"), "child\n");
        if (process.platform !== "win32") yield* fs.chmod(nested, 0o555);

        yield* copyDirectory(source, destination);

        expect(yield* fs.readFileString(path.join(destination, "nested", "child.txt"))).toBe(
          "child\n",
        );
        if (process.platform !== "win32") {
          expect(Number((yield* fs.stat(path.join(destination, "nested"))).mode) & 0o777).toBe(
            0o555,
          );
          yield* fs.chmod(nested, 0o755);
          yield* fs.chmod(path.join(destination, "nested"), 0o755);
        }
      }),
    ),
  );

  it.live("removes a failed host copy and copies the tree itself", () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "directory-copy-fallback-" });
        const source = path.join(root, "source");
        const destination = path.join(root, "destination");
        yield* fs.makeDirectory(source);
        yield* fs.writeFileString(path.join(source, "file.txt"), "file\n");

        yield* copyDirectory(source, destination).pipe(
          Effect.provideService(
            ChildProcessSpawner.ChildProcessSpawner,
            failedHostCopy(destination),
          ),
        );

        expect(yield* fs.readFileString(path.join(destination, "file.txt"))).toBe("file\n");
        expect(yield* fs.exists(path.join(destination, "nested"))).toBe(false);
      }),
    ),
  );

  it.live("removes a partial copy when the host copy is interrupted", () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "directory-copy-interrupt-" });
        const source = path.join(root, "source");
        const destination = path.join(root, "destination");
        const started = yield* Deferred.make<void>();
        yield* fs.makeDirectory(source);
        yield* fs.writeFileString(path.join(source, "file.txt"), "file\n");

        const fiber = yield* copyDirectory(source, destination).pipe(
          Effect.provideService(
            ChildProcessSpawner.ChildProcessSpawner,
            hangingCopy(started, destination),
          ),
          Effect.forkChild,
        );
        yield* Deferred.await(started);
        yield* Fiber.interrupt(fiber);

        expect(yield* fs.exists(destination)).toBe(false);
      }),
    ),
  );

  it.live("removes a partial copy when failure cleanup is interrupted", () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "directory-copy-cleanup-" });
        const source = path.join(root, "source");
        const destination = path.join(root, "destination");
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        yield* fs.makeDirectory(source);
        yield* fs.writeFileString(path.join(source, "file.txt"), "file\n");
        const pausing = FileSystem.FileSystem.of({
          ...fs,
          chmod: (target, mode) =>
            Effect.gen(function* () {
              if (target === destination) {
                yield* Deferred.succeed(entered, undefined);
                yield* Deferred.await(release);
              }
              yield* fs.chmod(target, mode);
            }),
        });

        const fiber = yield* copyDirectory(source, destination).pipe(
          Effect.provideService(FileSystem.FileSystem, pausing),
          Effect.provideService(
            ChildProcessSpawner.ChildProcessSpawner,
            failedHostCopy(destination),
          ),
          Effect.forkChild,
        );
        yield* Deferred.await(entered);
        yield* Effect.sync(() => {
          fiber.interruptUnsafe();
        });
        expect(fiber.pollUnsafe()).toBeUndefined();
        yield* Deferred.succeed(release, undefined);
        const exit = yield* Fiber.await(fiber);

        expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
        expect(yield* fs.exists(destination)).toBe(false);
      }),
    ),
  );
});

const processHandle = (exitCode: Effect.Effect<ChildProcessSpawner.ExitCode>) =>
  ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode,
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    stdin: Sink.drain,
    stdout: Stream.empty,
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });

const writePartial = (destination: string) => {
  const nested = join(destination, "nested");
  mkdirSync(nested, { recursive: true });
  writeFileSync(join(nested, "child.txt"), "partial\n");
  if (process.platform !== "win32") chmodSync(nested, 0o555);
};

const hostCommand = (command: ChildProcess.Command) => {
  if (!ChildProcess.isStandardCommand(command)) return Effect.die("unexpected piped command");
  if (command.command === "find") {
    return Effect.succeed(processHandle(Effect.succeed(ChildProcessSpawner.ExitCode(0))));
  }
  return undefined;
};

const hangingCopy = (started: Deferred.Deferred<void>, destination: string) =>
  ChildProcessSpawner.make((command) => {
    const find = hostCommand(command);
    if (find !== undefined) return find;
    return Effect.sync(() => {
      writePartial(destination);
      return processHandle(Effect.never);
    }).pipe(Effect.tap(() => Deferred.succeed(started, undefined)));
  });

// Exit 8 is a real robocopy failure and a non-zero cp status, not a usage error.
const failedHostCopy = (destination: string) =>
  ChildProcessSpawner.make((command) => {
    const find = hostCommand(command);
    if (find !== undefined) return find;
    return Effect.sync(() => {
      writePartial(destination);
      return processHandle(Effect.succeed(ChildProcessSpawner.ExitCode(8)));
    });
  });
