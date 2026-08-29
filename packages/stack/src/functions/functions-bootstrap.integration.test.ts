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
      expect(target).toContain(path.join(root, stackId, "runtime", "functions", "4", "main.ts"));
      expect((yield* fs.stat(path.dirname(target))).mode! & 0o777).toBe(0o700);
      expect((yield* fs.stat(target)).mode! & 0o777).toBe(0o600);
      expect(yield* fs.readFileString(target)).toBe("export default 1");
      yield* owner.cleanupGeneration(4);
      expect(yield* fs.exists(target)).toBe(false);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
