import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import {
  NATIVE_ROOT_UNSUPPORTED_MESSAGE,
  selectDefaultRuntime,
  selectDefaultRuntimeSelection,
  type ContainerEngineResolverShape,
} from "./ContainerEngineResolver.ts";

const unusedSpawner = ChildProcessSpawner.make(() => Effect.die("unused"));

const resolver = (opts: {
  readonly installed: boolean;
  readonly reachable?: boolean;
}): ContainerEngineResolverShape => {
  const reachable = opts.reachable;
  return {
    isInstalled: () => Effect.succeed(opts.installed),
    ...(reachable === undefined ? {} : { isDaemonReachable: () => Effect.succeed(reachable) }),
    resolve: () => Effect.die("unused"),
  };
};

describe("selectDefaultRuntime", () => {
  it.effect("selects Docker when the client is installed", () =>
    Effect.gen(function* () {
      expect(yield* selectDefaultRuntime(resolver({ installed: true }))).toEqual({
        kind: "container",
        engine: "docker",
      });
    }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, unusedSpawner)),
  );

  it.effect("selects native when Docker is not installed", () =>
    Effect.gen(function* () {
      expect(yield* selectDefaultRuntime(resolver({ installed: false }))).toEqual({
        kind: "native",
      });
    }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, unusedSpawner)),
  );

  it.effect("selects native when the Docker client is installed but the daemon is down", () =>
    Effect.gen(function* () {
      const selected = yield* selectDefaultRuntimeSelection(
        resolver({ installed: true, reachable: false }),
      );
      expect(selected.runtime).toEqual({ kind: "native" });
      expect(selected.dockerFallbackNotice).toContain("Docker daemon is not reachable");
    }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, unusedSpawner)),
  );

  it.effect("refuses native auto-select as uid 0", () =>
    Effect.gen(function* () {
      const failed = yield* selectDefaultRuntime(resolver({ installed: false }), { uid: 0 }).pipe(
        Effect.exit,
      );
      expect(Exit.isFailure(failed)).toBe(true);
      if (Exit.isFailure(failed)) {
        const error = failed.cause;
        expect(String(error)).toContain(NATIVE_ROOT_UNSUPPORTED_MESSAGE);
      }
    }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, unusedSpawner)),
  );

  it.effect("still selects Docker as uid 0 when the daemon is reachable", () =>
    Effect.gen(function* () {
      expect(yield* selectDefaultRuntime(resolver({ installed: true }), { uid: 0 })).toEqual({
        kind: "container",
        engine: "docker",
      });
    }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, unusedSpawner)),
  );
});
