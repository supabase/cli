import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, FileSystem, Fiber, Path } from "effect";
import { StackIdSchema } from "../identity/StackId.ts";
import { makeFunctionsBootstrapOwner } from "./FunctionsBootstrap.ts";

const setupBootstrapOwner = (prefix: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix });
    const stackId = StackIdSchema.make("a".repeat(64));
    const owner = yield* makeFunctionsBootstrapOwner({
      root,
      stackId,
      instanceId: "functions-one",
    });
    return { fs, root, stackId, owner };
  });

/** `ino` for every file a generation publishes together, keyed by name. */
const generationInodes = (fs: FileSystem.FileSystem, path: Path.Path, target: string) =>
  Effect.gen(function* () {
    const generation = path.dirname(target);
    return {
      index: (yield* fs.stat(path.join(generation, "index.ts"))).ino,
      config: (yield* fs.stat(path.join(generation, "deno.json"))).ino,
    };
  });

describe("functions bootstrap owner", () => {
  it.live("publishes a private Functions bootstrap file with restrictive modes", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const { fs, root, owner } = yield* setupBootstrapOwner("stack-functions-bootstrap-");
      const target = yield* owner.write({ content: "export default 1" });
      expect(path.dirname(path.dirname(target))).toContain(
        path.join(root, "functions-one", "runtime", "functions"),
      );
      expect(path.basename(target)).toBe("index.ts");
      expect(((yield* fs.stat(path.dirname(target))).mode ?? 0) & 0o777).toBe(0o700);
      expect(((yield* fs.stat(target)).mode ?? 0) & 0o777).toBe(0o600);
      expect(yield* fs.readFileString(target)).toBe("export default 1");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("returns the canonical published path for a symlinked state root", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: "stack-functions-bootstrap-alias-",
      });
      const canonicalRoot = path.join(root, "canonical");
      const configuredRoot = path.join(root, "alias");
      yield* fs.makeDirectory(canonicalRoot);
      yield* fs.symlink(canonicalRoot, configuredRoot);
      const stackIdValue = StackIdSchema.make("b".repeat(64));
      const owner = yield* makeFunctionsBootstrapOwner({
        root: configuredRoot,
        stackId: stackIdValue,
        instanceId: "functions-one",
      });

      const target = yield* owner.write({ content: "export default 2" });
      const expected = path.join(
        yield* fs.realPath(canonicalRoot),
        "functions-one",
        "runtime",
        "functions",
      );
      expect(path.dirname(path.dirname(target))).toBe(expected);
      expect(path.basename(target)).toBe("index.ts");
      expect(yield* fs.readFileString(target)).toBe("export default 2");
      expect(((yield* fs.stat(target)).mode ?? 0) & 0o777).toBe(0o600);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("keeps every published file's identity when identical content is written twice", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const { fs, owner } = yield* setupBootstrapOwner("stack-functions-bootstrap-idempotent-");
      const first = yield* owner.write({ content: "export default 1" });
      const before = yield* generationInodes(fs, path, first);

      const second = yield* owner.write({ content: "export default 1" });

      expect(second).toBe(first);
      expect(yield* generationInodes(fs, path, second)).toEqual(before);
      expect(yield* fs.readFileString(first)).toBe("export default 1");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("converges concurrent writers of identical content on one complete generation", () =>
    Effect.gen(function* () {
      const { fs, owner } = yield* setupBootstrapOwner("stack-functions-bootstrap-race-");
      const gate = yield* Deferred.make<void>();
      const fibers = yield* Effect.forEach(
        Array.from({ length: 20 }, () => undefined),
        () =>
          Deferred.await(gate).pipe(
            Effect.andThen(owner.write({ content: "export default race" })),
            Effect.forkScoped,
          ),
      );
      yield* Deferred.succeed(gate, undefined);
      const targets = yield* Effect.forEach(fibers, (fiber) => Fiber.join(fiber));

      expect(new Set(targets).size).toBe(1);
      const target = targets[0]!;
      expect(yield* fs.readFileString(target)).toBe("export default race");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
