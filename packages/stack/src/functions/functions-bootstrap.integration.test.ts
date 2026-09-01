import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import { isStackId } from "../public/StackId.ts";
import { makeFunctionsBootstrapOwner } from "./FunctionsBootstrap.ts";

describe("functions bootstrap owner", () => {
  it.live("publishes one private generation file with restrictive modes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-functions-bootstrap-" });
      const stackIdValue = "a".repeat(64);
      if (!isStackId(stackIdValue)) throw new Error("invalid test stack id");
      const stackId = stackIdValue;
      const owner = yield* makeFunctionsBootstrapOwner({ stateRoot: root, stackId });
      const target = yield* owner.write({ generation: 4, content: "export default 1" });
      expect(target).toContain(path.join(root, stackId, "runtime", "functions", "4", "index.ts"));
      expect((yield* fs.stat(path.dirname(target))).mode! & 0o777).toBe(0o700);
      expect((yield* fs.stat(target)).mode! & 0o777).toBe(0o600);
      expect(yield* fs.readFileString(target)).toBe("export default 1");
      yield* owner.cleanupGeneration(4);
      expect(yield* fs.exists(target)).toBe(false);
      const stale = yield* owner.write({ generation: 5, content: "export default 2" });
      yield* owner.cleanupAll;
      expect(yield* fs.exists(stale)).toBe(false);
      expect(yield* fs.exists(path.join(root, stackId, "runtime", "functions"))).toBe(false);
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
      const stackIdValue = "b".repeat(64);
      if (!isStackId(stackIdValue)) throw new Error("invalid test stack id");
      const owner = yield* makeFunctionsBootstrapOwner({
        stateRoot: configuredRoot,
        stackId: stackIdValue,
      });

      const target = yield* owner.write({ generation: 1, content: "export default 2" });
      const expected = path.join(
        yield* fs.realPath(canonicalRoot),
        stackIdValue,
        "runtime",
        "functions",
        "1",
        "index.ts",
      );
      expect(target).toBe(expected);
      expect(yield* fs.readFileString(target)).toBe("export default 2");
      expect((yield* fs.stat(target)).mode! & 0o777).toBe(0o600);

      yield* owner.cleanupAll;
      expect(yield* fs.exists(path.join(canonicalRoot, stackIdValue, "runtime", "functions"))).toBe(
        false,
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
