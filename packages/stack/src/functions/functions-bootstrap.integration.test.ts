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
      expect(target).toContain(
        path.join(root, "functions-one", "runtime", "functions", "index.ts"),
      );
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
        "index.ts",
      );
      expect(target).toBe(expected);
      expect(yield* fs.readFileString(target)).toBe("export default 2");
      expect(((yield* fs.stat(target)).mode ?? 0) & 0o777).toBe(0o600);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
