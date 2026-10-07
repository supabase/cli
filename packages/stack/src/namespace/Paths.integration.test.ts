import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Data, Effect, FileSystem, Path } from "effect";
import { borrow, destroyOwnedRoot, resolveStackDataRoot } from "./Paths.ts";

class TestPathsError extends Data.TaggedError("TestPathsError")<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

const onError = (operation: string, cause: unknown) => new TestPathsError({ operation, cause });

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(effect).pipe(Effect.provide(NodeServices.layer));

describe("ownership is by location", () => {
  it.live("rejects a borrowed path that resolves inside the stack's data root", () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dataRoot = yield* fs.makeTempDirectoryScoped({ prefix: "owned-root-reject-" });
        const ownedRoot = path.join(dataRoot, "instance");
        yield* fs.makeDirectory(ownedRoot, { recursive: true });
        const inside = path.join(ownedRoot, "config.yaml");
        yield* fs.writeFileString(inside, "borrowed");
        const failure = yield* borrow(fs, path, inside, dataRoot, onError).pipe(Effect.flip);
        expect(failure.operation).toBe("configure");
      }),
    ),
  );

  it.live("rejects a borrowed path equal to the stack's data root", () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dataRoot = yield* fs.makeTempDirectoryScoped({ prefix: "owned-root-equal-" });
        const failure = yield* borrow(fs, path, dataRoot, dataRoot, onError).pipe(Effect.flip);
        expect(failure.operation).toBe("configure");
      }),
    ),
  );

  it.live("rejects a borrowed path inside a sibling instance under the same data root", () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dataRoot = yield* fs.makeTempDirectoryScoped({ prefix: "owned-root-sibling-" });
        const siblingInstance = path.join(dataRoot, "mail-instance");
        yield* fs.makeDirectory(siblingInstance, { recursive: true });
        const inside = path.join(siblingInstance, "pipeline.yaml");
        yield* fs.writeFileString(inside, "borrowed");
        const failure = yield* borrow(fs, path, inside, dataRoot, onError).pipe(Effect.flip);
        expect(failure.operation).toBe("configure");
      }),
    ),
  );

  it.live("accepts a borrowed path outside the stack's data root", () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dataRoot = yield* fs.makeTempDirectoryScoped({ prefix: "owned-root-accept-" });
        const outside = yield* fs.makeTempDirectoryScoped({ prefix: "owned-root-caller-" }).pipe(
          Effect.flatMap((root) => {
            const file = path.join(root, "caller-config.yaml");
            return fs.writeFileString(file, "borrowed").pipe(Effect.as(file));
          }),
        );
        const borrowed = yield* borrow(fs, path, outside, dataRoot, onError);
        expect(borrowed.path).toBe(outside);
      }),
    ),
  );

  it.live("accepts a borrowed path that does not exist yet, under a real ancestor", () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dataRoot = yield* fs.makeTempDirectoryScoped({ prefix: "owned-root-pending-" });
        const outsideRoot = yield* fs.makeTempDirectoryScoped({
          prefix: "owned-root-pending-out-",
        });
        const notYetCreated = path.join(outsideRoot, "not-created-yet.yaml");
        yield* borrow(fs, path, notYetCreated, dataRoot, onError);
      }),
    ),
  );

  it.live("recursively removes a real owned root after running removeData", () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const parentRoot = yield* fs.makeTempDirectoryScoped({ prefix: "owned-root-destroy-" });
        const ownedRoot = path.join(parentRoot, "instance");
        yield* fs.makeDirectory(path.join(ownedRoot, "nested"), { recursive: true });
        yield* fs.writeFileString(path.join(ownedRoot, "nested", "file"), "data");
        let removeDataRan = false;
        yield* destroyOwnedRoot(
          fs,
          path,
          ownedRoot,
          parentRoot,
          Effect.sync(() => {
            removeDataRan = true;
          }),
          onError,
        );
        expect(removeDataRan).toBe(true);
        expect(yield* fs.exists(ownedRoot)).toBe(false);
      }),
    ),
  );

  it.live("runs removeData even when the owned root was never created", () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const parentRoot = yield* fs.makeTempDirectoryScoped({ prefix: "owned-root-absent-" });
        const ownedRoot = path.join(parentRoot, "instance");
        let removeDataRan = false;
        yield* destroyOwnedRoot(
          fs,
          path,
          ownedRoot,
          parentRoot,
          Effect.sync(() => {
            removeDataRan = true;
          }),
          onError,
        );
        expect(removeDataRan).toBe(true);
      }),
    ),
  );

  it.live("keeps listed entries after removeData, removing the rest", () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const parentRoot = yield* fs.makeTempDirectoryScoped({ prefix: "owned-root-keep-" });
        const ownedRoot = path.join(parentRoot, "instance");
        yield* fs.makeDirectory(ownedRoot, { recursive: true });
        yield* fs.writeFileString(path.join(ownedRoot, "snapshots"), "keep-me");
        yield* fs.writeFileString(path.join(ownedRoot, "data"), "remove-me");
        yield* destroyOwnedRoot(fs, path, ownedRoot, parentRoot, Effect.void, onError, [
          "snapshots",
        ]);
        expect(yield* fs.readDirectory(ownedRoot)).toEqual(["snapshots"]);
      }),
    ),
  );

  it.live(
    "refuses to destroy a root that is a symlink to an outside directory, which survives",
    () =>
      run(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const parentRoot = yield* fs.makeTempDirectoryScoped({ prefix: "owned-root-symlink-" });
          const outside = yield* fs.makeTempDirectoryScoped({ prefix: "owned-root-outside-" });
          const sentinel = path.join(outside, "sentinel");
          yield* fs.writeFileString(sentinel, "do not remove me");
          const ownedRoot = path.join(parentRoot, "instance");
          yield* fs.symlink(outside, ownedRoot);
          // Destructive: if confirmRealOwnedDirectory ran after this (or not at all), the sentinel
          // outside the owned root would actually be deleted, not just silently skipped.
          const failure = yield* destroyOwnedRoot(
            fs,
            path,
            ownedRoot,
            parentRoot,
            fs
              .remove(sentinel, { force: true })
              .pipe(Effect.mapError((cause) => onError("destroy", cause))),
            onError,
          ).pipe(Effect.flip);
          expect(failure.operation).toBe("destroy");
          expect(yield* fs.exists(sentinel)).toBe(true);
        }),
      ),
  );

  it.live("refuses to destroy a symlinked root even when keep entries are requested", () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const parentRoot = yield* fs.makeTempDirectoryScoped({
          prefix: "owned-root-symlink-keep-",
        });
        const outside = yield* fs.makeTempDirectoryScoped({
          prefix: "owned-root-outside-keep-",
        });
        const sentinel = path.join(outside, "sentinel");
        yield* fs.writeFileString(sentinel, "do not remove me");
        const ownedRoot = path.join(parentRoot, "instance");
        yield* fs.symlink(outside, ownedRoot);
        const failure = yield* destroyOwnedRoot(
          fs,
          path,
          ownedRoot,
          parentRoot,
          fs
            .remove(sentinel, { force: true })
            .pipe(Effect.mapError((cause) => onError("destroy", cause))),
          onError,
          ["sentinel"],
        ).pipe(Effect.flip);
        expect(failure.operation).toBe("destroy");
        expect(yield* fs.exists(sentinel)).toBe(true);
      }),
    ),
  );
});

describe("the stack data root", () => {
  it.live("is refused at launch when it is a symlink", () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-data-root-symlink-" });
        const outside = path.join(root, "outside");
        yield* fs.makeDirectory(outside);
        yield* fs.makeDirectory(path.join(root, "state", "stack"), { recursive: true });
        yield* fs.symlink(outside, path.join(root, "state", "stack", "data"));

        const failure = yield* resolveStackDataRoot(path.join(root, "state"), "stack").pipe(
          Effect.flip,
        );

        expect(failure.message).toContain("symlink");
      }),
    ),
  );
});
