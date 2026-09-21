import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, FileSystem, Path, Scope } from "effect";
import { copyDirectory } from "./DirectoryCopy.ts";

const run = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Scope.Scope>) =>
  Effect.scoped(effect).pipe(Effect.provide(NodeServices.layer));

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
});
