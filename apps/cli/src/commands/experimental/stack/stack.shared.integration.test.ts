import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path } from "effect";
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

const workspace = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "stack-target-" }));
  const home = path.join(root, ".supabase");
  const register = (options: {
    readonly projectRoot: string;
    readonly name?: string;
    readonly runtime?: "native" | "docker";
  }) =>
    Effect.gen(function* () {
      const api = yield* StackApi;
      const stack = yield* api.create({
        projectRoot: options.projectRoot,
        ...(options.name === undefined ? {} : { name: options.name }),
        stateRoot: path.join(home, "stacks"),
        cacheRoot: path.join(home, "cache", "stack"),
        runtime: options.runtime ?? "native",
      });
      return stack.id;
    }).pipe(Effect.scoped, Effect.provide(stackApiLayer));
  const resolve = (input: TargetInput) =>
    Effect.gen(function* () {
      const resolver = yield* StackTargetResolver;
      return yield* resolver.resolve(input);
    }).pipe(
      Effect.provide(
        stackTargetResolverLayer.pipe(
          Layer.provide(mockCommandSettings({ workdir: root, supabaseHome: home })),
          Layer.provide(stackApiLayer),
        ),
      ),
    );
  return { root, home, register, resolve };
});

describe("stack target resolver", () => {
  it.live("resolves an explicit id without reading the current project identity", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { root, register, resolve } = yield* workspace;
      const storedRoot = path.join(root, "stored-project");
      yield* fs.makeDirectory(storedRoot);
      const id = yield* register({ projectRoot: storedRoot });

      const target = yield* resolve({
        projectRoot: path.join(root, "missing-current-project"),
        id,
        runtime: "auto",
      });

      expect(target).toMatchObject({
        projectRoot: storedRoot,
        id,
        runtime: "native",
        hostRunning: false,
      });
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("rejects an explicit id when its saved runtime differs", () =>
    Effect.gen(function* () {
      const { root, register, resolve } = yield* workspace;
      const id = yield* register({ projectRoot: root, runtime: "docker" });

      const failure = yield* resolve({ projectRoot: root, id, runtime: "native" }).pipe(
        Effect.flip,
      );

      expect(failure).toBeInstanceOf(StackTargetError);
      expect(failure.reason).toBe("flags");
      expect(failure.message).toContain("Requested runtime native");
      expect(failure.message).toContain("existing stack runtime docker");
      expect(failure.suggestion).toContain("--runtime auto");
      expect(failure.suggestion).toContain("different --stack name");
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("selects the saved stack whose identity the project and stack name derive", () =>
    Effect.gen(function* () {
      const { root, register, resolve } = yield* workspace;
      yield* register({ projectRoot: root });
      const id = yield* register({ projectRoot: root, name: "feature" });

      const target = yield* resolve({ projectRoot: root, name: "feature", runtime: "auto" });

      expect(target).toMatchObject({ projectRoot: root, id, name: "feature" });
      expect(target.definition?.identity.stackName).toBe("feature");
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("reports no id when the project has no saved stack", () =>
    Effect.gen(function* () {
      const { root, resolve } = yield* workspace;

      const target = yield* resolve({ projectRoot: root, runtime: "docker" });

      expect(target).toEqual({ projectRoot: root, runtime: "docker", hostRunning: false });
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("returns the canonical project root for a new stack reached through a symlink", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { root, resolve } = yield* workspace;
      const link = path.join(root, "link");
      yield* fs.symlink(root, link);

      const target = yield* resolve({ projectRoot: link, runtime: "auto" });

      expect(target.projectRoot).toBe(root);
      expect(target.id).toBeUndefined();
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("surfaces an unreadable saved stack instead of reporting it missing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { root, home, register, resolve } = yield* workspace;
      const id = yield* register({ projectRoot: root });
      yield* fs.writeFileString(path.join(home, "stacks", id, "state.json"), "{broken");

      const failure = yield* resolve({ projectRoot: root, runtime: "auto" }).pipe(Effect.flip);

      expect(failure).toBeInstanceOf(StackTargetError);
      expect(failure.reason).toBe("invalid-config");
      expect(failure.message).toContain(id);
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
