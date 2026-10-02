import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
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

  it.live("cleans one Functions bootstrap while preserving another instance", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const { fs, root, stackId, owner } = yield* setupBootstrapOwner(
        "stack-functions-bootstrap-cleanup-",
      );
      const target = yield* owner.write({ content: "export default 1" });
      const other = yield* makeFunctionsBootstrapOwner({
        root,
        stackId,
        instanceId: "functions-two",
      });
      const otherTarget = yield* other.write({ content: "export default 2" });

      expect(yield* fs.exists(target)).toBe(true);

      yield* owner.cleanupAll;

      expect(yield* fs.exists(target)).toBe(false);
      expect(yield* fs.readFileString(otherTarget)).toBe("export default 2");
      expect(yield* fs.exists(path.join(root, "functions-one", "runtime", "functions"))).toBe(
        false,
      );
      expect(yield* fs.exists(path.join(root, "functions-one"))).toBe(false);
      expect(yield* fs.exists(path.join(root, "functions-two"))).toBe(true);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("recreates readable Functions bootstrap content after cleanup", () =>
    Effect.gen(function* () {
      const { fs, owner } = yield* setupBootstrapOwner("stack-functions-bootstrap-recreate-");
      const first = yield* owner.write({ content: "export default 1" });

      expect(yield* fs.exists(first)).toBe(true);

      yield* owner.cleanupAll;

      expect(yield* fs.exists(first)).toBe(false);
      const recreated = yield* owner.write({ content: "export default 2" });

      expect(yield* fs.readFileString(recreated)).toBe("export default 2");
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

      yield* owner.cleanupAll;
      expect(
        yield* fs.exists(path.join(canonicalRoot, "functions-one", "runtime", "functions")),
      ).toBe(false);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("prunes a stale generation while keeping the live one, through a symlinked root", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: "stack-functions-bootstrap-prune-",
      });
      const canonicalRoot = path.join(root, "canonical");
      const configuredRoot = path.join(root, "alias");
      yield* fs.makeDirectory(canonicalRoot);
      yield* fs.symlink(canonicalRoot, configuredRoot);
      const owner = yield* makeFunctionsBootstrapOwner({
        root: configuredRoot,
        stackId: StackIdSchema.make("c".repeat(64)),
        instanceId: "functions-one",
      });
      const targetA = yield* owner.write({ content: "export default A" });
      const targetB = yield* owner.write({ content: "export default B" });

      yield* owner.pruneOthers(path.dirname(targetB));

      expect(yield* fs.exists(targetA)).toBe(false);
      expect(yield* fs.exists(targetB)).toBe(true);
      expect(yield* fs.readFileString(targetB)).toBe("export default B");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("keeps the published file when identical content is written twice", () =>
    Effect.gen(function* () {
      const { fs, owner } = yield* setupBootstrapOwner("stack-functions-bootstrap-idempotent-");
      const first = yield* owner.write({ content: "export default 1" });
      const second = yield* owner.write({ content: "export default 1" });

      expect(second).toBe(first);
      expect(yield* fs.readFileString(first)).toBe("export default 1");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("publishes once when overlapping writers race with identical content", () =>
    Effect.gen(function* () {
      const { fs, owner } = yield* setupBootstrapOwner("stack-functions-bootstrap-race-");
      const targets = yield* Effect.all(
        Array.from({ length: 20 }, () => owner.write({ content: "export default race" })),
        { concurrency: "unbounded" },
      );

      expect(new Set(targets).size).toBe(1);
      expect(yield* fs.readFileString(targets[0]!)).toBe("export default race");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("never prunes an in-flight staging entry", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { owner, root } = yield* setupBootstrapOwner("stack-functions-bootstrap-staging-");
      const published = yield* owner.write({ content: "export default 1" });
      const ownedRoot = path.join(root, "functions-one", "runtime", "functions");
      const staging = path.join(ownedRoot, ".generation-in-flight.tmp");
      yield* fs.makeDirectory(staging, { recursive: true });

      yield* owner.pruneOthers(path.dirname(published));

      expect(yield* fs.exists(staging)).toBe(true);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
