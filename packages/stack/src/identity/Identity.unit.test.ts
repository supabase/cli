import { describe, expect, it } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import { Effect, Path } from "effect";
import { projectSegmentFor } from "./Identity.ts";

const identity = (projectRoot: string, stackName = "default") => ({
  projectRoot,
  branchContext: "ordinary-workspace",
  stackName,
});

describe("projectSegmentFor", () => {
  it.effect("uses the project folder name", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      expect(projectSegmentFor(identity("/work/my.app"), path)).toBe("my.app");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("appends a non-default stack name so sibling stacks stay distinguishable", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      expect(projectSegmentFor(identity("/work/my.app", "test"), path)).toBe("my.app-test");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("falls back to the stack name for the filesystem root", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      expect(projectSegmentFor(identity("/"), path)).toBe("default");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
