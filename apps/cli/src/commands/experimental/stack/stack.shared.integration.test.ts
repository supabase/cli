import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, FileSystem, Layer, Option, Path } from "effect";
import { resolveStackIdentity } from "@supabase/stack/internal/identity";
import {
  StackApi,
  StackTargetError,
  StackTargetResolver,
  stackApiLayer,
  stackTargetResolverLayer,
} from "./stack.shared.ts";
import { mockCommandSettings } from "../../../../tests/helpers/command-mocks.ts";

type TargetInput = {
  readonly projectRoot: string;
  readonly name?: string;
  readonly id?: string;
  readonly runtime: "auto" | "docker" | "native";
};

type DiscoveredStack = Effect.Success<
  ReturnType<StackApi["Service"]["discover"]>
>[number]["definition"];

const stack = (
  id: string,
  identity: DiscoveredStack["identity"],
  runtime: DiscoveredStack["runtime"] = "native",
): DiscoveredStack => ({
  id,
  identity,
  runtime,
  instances: [],
  composition: { members: [], dependencies: [] },
  ports: [],
});

const resolverLayer = (
  discovered: ReadonlyArray<DiscoveredStack>,
  workdir: string,
  supabaseHome: string,
) => {
  const api = Layer.succeed(StackApi, {
    create: () => Effect.die("unused"),
    open: () => Effect.die("unused"),
    discover: () =>
      Effect.succeed(discovered.map((definition) => ({ definition, host: undefined }))),
    resolveIdentity: (options) =>
      resolveStackIdentity(options).pipe(Effect.provide(BunServices.layer)),
  });
  return stackTargetResolverLayer.pipe(
    Layer.provide(mockCommandSettings({ workdir, supabaseHome })),
    Layer.provide(api),
    Layer.provide(BunServices.layer),
  );
};

const resolveTarget = (layer: Layer.Layer<StackTargetResolver>, input: TargetInput) =>
  Effect.gen(function* () {
    const resolver = yield* StackTargetResolver;
    return yield* resolver.resolve(input);
  }).pipe(Effect.provide(layer));

describe("stack target resolver", () => {
  it.live("resolves an explicit id without reading the current project identity", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-target-id-" });
      const storedRoot = path.join(root, "stored-project");
      const id = "a".repeat(64);
      const target = yield* resolveTarget(
        resolverLayer(
          [stack(id, { projectRoot: storedRoot, branchContext: "main", stackName: "default" })],
          root,
          path.join(root, ".supabase"),
        ),
        { projectRoot: path.join(root, "missing-current-project"), id, runtime: "auto" },
      );
      expect(target).toEqual({ projectRoot: storedRoot, id, runtime: "native" });
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("rejects an explicit id when its saved runtime differs", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-target-runtime-" });
      const id = "b".repeat(64);
      const exit = yield* resolveTarget(
        resolverLayer(
          [stack(id, { projectRoot: root, branchContext: "main", stackName: "default" }, "docker")],
          root,
          path.join(root, ".supabase"),
        ),
        { projectRoot: root, id, runtime: "native" },
      ).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Exit.findErrorOption(exit);
        expect(Option.isSome(failure)).toBe(true);
        if (Option.isSome(failure)) {
          expect(failure.value).toBeInstanceOf(StackTargetError);
          if (failure.value instanceof StackTargetError) {
            expect(failure.value.reason).toBe("flags");
            expect(failure.value.message).toContain("Requested runtime native");
            expect(failure.value.message).toContain("existing stack runtime docker");
            expect(failure.value.suggestion).toContain("--runtime auto");
            expect(failure.value.suggestion).toContain("different --stack name");
          }
        }
      }
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("selects a saved stack by the package identity tuple", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-target-identity-" });
      const canonicalRoot = yield* fs.realPath(root);
      const identity = yield* resolveStackIdentity({ projectRoot: root, name: "feature" }).pipe(
        Effect.provide(BunServices.layer),
      );
      const id = "c".repeat(64);
      const target = yield* resolveTarget(
        resolverLayer(
          [stack("d".repeat(64), { ...identity, branchContext: "other" }), stack(id, identity)],
          root,
          path.join(root, ".supabase"),
        ),
        { projectRoot: root, name: "feature", runtime: "auto" },
      );
      expect(target).toMatchObject({ projectRoot: canonicalRoot, id, name: "feature" });
    }).pipe(Effect.provide(BunServices.layer)),
  );
});

describe("stack API layer", () => {
  it.live("creates, discovers, and opens state without starting an owner", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-api-layer-" });
      const api = yield* StackApi.pipe(Effect.provide(stackApiLayer));
      const locations = {
        projectRoot: root,
        stateRoot: path.join(root, ".supabase", "stacks"),
        cacheRoot: path.join(root, ".supabase", "cache"),
        runtime: "native" as const,
      };
      const created = yield* api.create(locations);
      const discovered = yield* api.discover({ stateRoot: locations.stateRoot });
      const opened = yield* api.open({
        stateRoot: locations.stateRoot,
        cacheRoot: locations.cacheRoot,
        id: created.id,
      });
      expect(discovered).toHaveLength(1);
      expect(discovered[0]?.definition.id).toBe(created.id);
      expect(discovered[0]?.host).toBeUndefined();
      expect(opened.id).toBe(created.id);
    }).pipe(Effect.provide(BunServices.layer)),
  );
});
