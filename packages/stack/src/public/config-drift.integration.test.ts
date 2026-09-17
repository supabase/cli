import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import { createStack, inspectStack } from "./EffectStack.ts";
import {
  defaultRuntimeEnvironment,
  StackRuntimeEnvironment,
  type StackRuntimeEnvironmentValue,
} from "../supervisor/Launcher.ts";

const withRuntimeRoot = <A, E, R>(effect: (project: string) => Effect.Effect<A, E, R>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({ prefix: "supabase-config-drift-" });
      yield* Effect.addFinalizer(() =>
        fs.remove(root, { recursive: true, force: true }).pipe(Effect.ignore),
      );
      const project = path.join(root, "project");
      yield* fs.makeDirectory(project);
      const defaults = yield* defaultRuntimeEnvironment;
      const runtime: StackRuntimeEnvironmentValue = {
        ...defaults,
        stateRoot: path.join(root, "managed", "stacks"),
        tempRoot: "/tmp",
        platform: "posix",
      };
      return yield* effect(project).pipe(Effect.provideService(StackRuntimeEnvironment, runtime));
    }),
  ).pipe(Effect.provide(NodeServices.layer));

describe("inspectStack config drift", () => {
  it.live("reports candidate drift without exposing runtime secrets", () =>
    withRuntimeRoot((projectRoot) =>
      Effect.gen(function* () {
        const stack = yield* createStack({
          projectRoot,
          runtime: { kind: "native" },
          initialConfig: {},
        });
        const inspection = yield* inspectStack(stack.id, { config: {} });
        expect(inspection.owner).toBe("absent");
        expect(inspection.configDrift).toEqual({ status: "changed", paths: ["services"] });
      }),
    ),
  );

  it.live("rejects an unsupported candidate version before changing state", () =>
    withRuntimeRoot((projectRoot) =>
      Effect.gen(function* () {
        const stack = yield* createStack({
          projectRoot,
          runtime: { kind: "native" },
          initialConfig: {},
        });
        const result = yield* inspectStack(stack.id, {
          config: { capabilities: { database: { version: "unsupported" } } },
        }).pipe(Effect.exit);
        expect(result._tag).toBe("Failure");
      }),
    ),
  );
});
