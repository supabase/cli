import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, FileSystem } from "effect";

import { createTestStack } from "../index.ts";

describe("Promise test stack facade", () => {
  it.live("maps setup failure and removes the created project root", () =>
    Effect.gen(function* () {
      let projectRoot: string | undefined;
      const result = yield* Effect.exit(
        Effect.promise(() =>
          createTestStack({
            // oxlint-disable-next-line effecttsgo/async-function -- Exercises the public Promise setup boundary.
            setupProject: async (root) => {
              projectRoot = root;
              throw new Error("promise setup failed");
            },
          }),
        ),
      );
      expect(Exit.isFailure(result)).toBe(true);
      if (Exit.isFailure(result))
        expect(Cause.squash(result.cause)).toMatchObject({ message: "promise setup failed" });
      expect(projectRoot).toBeDefined();
      const fs = yield* FileSystem.FileSystem;
      expect(yield* fs.exists(projectRoot ?? "")).toBe(false);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
