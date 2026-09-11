import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import {
  selectDefaultRuntime,
  type ContainerEngineResolverShape,
} from "./ContainerEngineResolver.ts";

const unusedSpawner = ChildProcessSpawner.make(() => Effect.die("unused"));

const resolver = (installed: boolean): ContainerEngineResolverShape => ({
  isInstalled: () => Effect.succeed(installed),
  resolve: () => Effect.die("unused"),
});

describe("selectDefaultRuntime", () => {
  it.effect("selects Docker when the client is installed", () =>
    Effect.gen(function* () {
      expect(yield* selectDefaultRuntime(resolver(true))).toEqual({
        kind: "container",
        engine: "docker",
      });
    }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, unusedSpawner)),
  );

  it.effect("selects native when Docker is not installed", () =>
    Effect.gen(function* () {
      expect(yield* selectDefaultRuntime(resolver(false))).toEqual({ kind: "native" });
    }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, unusedSpawner)),
  );
});
