import { BunCrypto, BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Effect, FileSystem, Layer, Path, Ref } from "effect";
import {
  StackApi,
  StackTargetError,
  StackTargetResolver,
  stackApiLayer,
  stackTargetResolverLayer,
} from "../../../command-internal/stack-target.ts";
import { mockCommandSettings } from "../../../../tests/helpers/command-mocks.ts";
import {
  CommandTelemetryAttributes,
  type CommandTelemetryAttributeValues,
} from "../../../telemetry/command-telemetry-attributes.ts";

type TargetInput = {
  readonly projectRoot: string;
  readonly stack?: string;
  readonly runtime: "auto" | "docker" | "podman" | "native";
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

const withEnv =
  (env: Readonly<Record<string, string>>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.provideService(effect, ConfigProvider.ConfigProvider, ConfigProvider.fromEnvRecord(env));

describe("stack target resolver", () => {
  it.effect("resolves an explicit id without reading the current project identity", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { root, register, resolve } = yield* workspace;
      const storedRoot = path.join(root, "stored-project");
      yield* fs.makeDirectory(storedRoot);
      const id = yield* register({ projectRoot: storedRoot });

      const target = yield* resolve({
        projectRoot: path.join(root, "missing-current-project"),
        stack: id,
        runtime: "auto",
      });

      expect(target).toMatchObject({
        projectRoot: storedRoot,
        id,
        runtime: "native",
        hostRunning: false,
      });
    }).pipe(Effect.provide([BunServices.layer, BunCrypto.layer])),
  );

  it.effect("rejects an id prefix that several readable or unreadable saved stacks share", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { root, home, register, resolve } = yield* workspace;
      const id = yield* register({ projectRoot: root });
      const twin = `${id.slice(0, 8)}${id.slice(8).replace(/./gu, (c) => (c === "0" ? "1" : "0"))}`;
      const saved = yield* fs.readFileString(path.join(home, "stacks", id, "state.json"));
      yield* fs.makeDirectory(path.join(home, "stacks", twin));
      yield* fs.writeFileString(
        path.join(home, "stacks", twin, "state.json"),
        saved.replaceAll(id, twin),
      );
      const broken = `${id.slice(0, 8)}${"f".repeat(56)}`;
      yield* fs.makeDirectory(path.join(home, "stacks", broken));
      yield* fs.writeFileString(path.join(home, "stacks", broken, "state.json"), "{broken");

      const failure = yield* resolve({
        projectRoot: root,
        stack: id.slice(0, 8),
        runtime: "auto",
      }).pipe(Effect.flip);

      expect(failure.reason).toBe("flags");
      expect(failure.message).toContain(`Stack id prefix ${id.slice(0, 8)} matches 3 stacks`);
      expect(failure.message).toContain(id);
      expect(failure.message).toContain(twin);
      expect(failure.message).toContain(broken);
    }).pipe(Effect.provide([BunServices.layer, BunCrypto.layer])),
  );

  it.effect("treats a value too short for an ID as the name of a new stack", () =>
    Effect.gen(function* () {
      const { root, register, resolve } = yield* workspace;
      const id = yield* register({ projectRoot: root });

      const target = yield* resolve({ projectRoot: root, stack: id.slice(0, 3), runtime: "auto" });

      expect(target).toEqual({ projectRoot: root, name: id.slice(0, 3), hostRunning: false });
    }).pipe(Effect.provide([BunServices.layer, BunCrypto.layer])),
  );

  it.effect("rejects an explicit id when its saved runtime differs", () =>
    Effect.gen(function* () {
      const { root, register, resolve } = yield* workspace;
      const id = yield* register({ projectRoot: root, runtime: "docker" });

      const failure = yield* resolve({ projectRoot: root, stack: id, runtime: "native" }).pipe(
        Effect.flip,
      );

      expect(failure).toBeInstanceOf(StackTargetError);
      expect(failure.reason).toBe("flags");
      expect(failure.message).toContain("Requested runtime native");
      expect(failure.message).toContain("existing stack runtime docker");
      expect(failure.suggestion).toContain("--runtime auto");
      expect(failure.suggestion).toContain("different --stack name");
    }).pipe(Effect.provide([BunServices.layer, BunCrypto.layer])),
  );

  it.effect("selects the saved stack whose identity the project and stack name derive", () =>
    Effect.gen(function* () {
      const { root, register, resolve } = yield* workspace;
      yield* register({ projectRoot: root });
      const id = yield* register({ projectRoot: root, name: "feature" });

      const target = yield* resolve({ projectRoot: root, stack: "feature", runtime: "auto" });

      expect(target).toMatchObject({ projectRoot: root, id, name: "feature" });
      expect(target.definition?.identity.stackName).toBe("feature");
    }).pipe(Effect.provide([BunServices.layer, BunCrypto.layer])),
  );

  it.effect("selects the stack SUPABASE_STACK names when no selector is passed", () =>
    Effect.gen(function* () {
      const { root, register, resolve } = yield* workspace;
      yield* register({ projectRoot: root });
      const id = yield* register({ projectRoot: root, name: "feature" });

      const target = yield* resolve({ projectRoot: root, runtime: "auto" }).pipe(
        withEnv({ SUPABASE_STACK: "feature" }),
      );

      expect(target).toMatchObject({ id, name: "feature" });
    }).pipe(Effect.provide([BunServices.layer, BunCrypto.layer])),
  );

  it.effect("prefers a --stack name over a SUPABASE_STACK ID", () =>
    Effect.gen(function* () {
      const { root, register, resolve } = yield* workspace;
      const other = yield* register({ projectRoot: root, name: "other" });
      const id = yield* register({ projectRoot: root, name: "feature" });

      const target = yield* resolve({ projectRoot: root, stack: "feature", runtime: "auto" }).pipe(
        withEnv({ SUPABASE_STACK: other }),
      );

      expect(target).toMatchObject({ id, name: "feature" });
    }).pipe(Effect.provide([BunServices.layer, BunCrypto.layer])),
  );

  it.effect("resolves a stack name before an ID prefix that matches it", () =>
    Effect.gen(function* () {
      const { root, register, resolve } = yield* workspace;
      const byId = yield* register({ projectRoot: root });
      const prefix = byId.slice(0, 8);
      const byName = yield* register({ projectRoot: root, name: prefix });

      const named = yield* resolve({ projectRoot: root, stack: prefix, runtime: "auto" });
      const identified = yield* resolve({ projectRoot: root, stack: byId, runtime: "auto" });

      expect(named).toMatchObject({ id: byName, name: prefix });
      expect(identified).toMatchObject({ id: byId });
      expect(identified.name).toBeUndefined();
    }).pipe(Effect.provide([BunServices.layer, BunCrypto.layer])),
  );

  it.effect("selects another project's stack by ID only from an explicit --stack", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { root, register, resolve } = yield* workspace;
      const otherRoot = path.join(root, "other-project");
      yield* fs.makeDirectory(otherRoot);
      const id = yield* register({ projectRoot: otherRoot });
      const own = yield* register({ projectRoot: root, name: "feature" });

      const fromEnv = yield* resolve({ projectRoot: root, runtime: "auto" }).pipe(
        withEnv({ SUPABASE_STACK: id.slice(0, 8) }),
        Effect.flip,
      );
      const ownFromEnv = yield* resolve({ projectRoot: root, runtime: "auto" }).pipe(
        withEnv({ SUPABASE_STACK: own.slice(0, 8) }),
      );
      const explicit = yield* resolve({
        projectRoot: root,
        stack: id.slice(0, 8),
        runtime: "auto",
      });

      expect(fromEnv).toMatchObject({
        reason: "flags",
        message: `SUPABASE_STACK selects stack ${id} of ${otherRoot}, not of this project (${root}).`,
        suggestion: `Unset SUPABASE_STACK, or pass --stack ${id} to target that stack explicitly.`,
      });
      expect(ownFromEnv).toMatchObject({ id: own });
      expect(explicit).toMatchObject({ projectRoot: otherRoot, id });
    }).pipe(Effect.provide([BunServices.layer, BunCrypto.layer])),
  );

  it.effect("lists every other project's stack a SUPABASE_STACK prefix matches", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { root, home, register, resolve } = yield* workspace;
      const otherRoot = path.join(root, "other-project");
      yield* fs.makeDirectory(otherRoot);
      const id = yield* register({ projectRoot: otherRoot });
      const twin = `${id.slice(0, 8)}${id.slice(8).replace(/./gu, (c) => (c === "0" ? "1" : "0"))}`;
      const saved = yield* fs.readFileString(path.join(home, "stacks", id, "state.json"));
      yield* fs.makeDirectory(path.join(home, "stacks", twin));
      yield* fs.writeFileString(
        path.join(home, "stacks", twin, "state.json"),
        saved.replaceAll(id, twin),
      );

      const failure = yield* resolve({ projectRoot: root, runtime: "auto" }).pipe(
        withEnv({ SUPABASE_STACK: id.slice(0, 8) }),
        Effect.flip,
      );

      expect(failure.reason).toBe("flags");
      expect(failure.message).toContain(`Stack id prefix ${id.slice(0, 8)} matches 2 stacks`);
      expect(failure.message).toContain(id);
      expect(failure.message).toContain(twin);
    }).pipe(Effect.provide([BunServices.layer, BunCrypto.layer])),
  );

  it.effect("records the saved stack's runtime on the command event", () =>
    Effect.gen(function* () {
      const { root, register, resolve } = yield* workspace;
      yield* register({ projectRoot: root, runtime: "docker" });
      const recorded = yield* Ref.make<CommandTelemetryAttributeValues>({});

      yield* resolve({ projectRoot: root, runtime: "auto" }).pipe(
        Effect.provideService(CommandTelemetryAttributes, {
          record: (values) => Ref.update(recorded, (current) => ({ ...current, ...values })),
        }),
      );

      expect((yield* Ref.get(recorded)).stack_runtime).toBe("docker");
    }).pipe(Effect.provide([BunServices.layer, BunCrypto.layer])),
  );

  it.effect("reports no id when the project has no saved stack", () =>
    Effect.gen(function* () {
      const { root, resolve } = yield* workspace;

      const target = yield* resolve({ projectRoot: root, runtime: "docker" });

      expect(target).toEqual({ projectRoot: root, runtime: "docker", hostRunning: false });
    }).pipe(Effect.provide([BunServices.layer, BunCrypto.layer])),
  );

  it.effect("carries an explicit Podman runtime onto a new stack target and records it", () =>
    Effect.gen(function* () {
      const { root, resolve } = yield* workspace;
      const recorded = yield* Ref.make<CommandTelemetryAttributeValues>({});

      const target = yield* resolve({ projectRoot: root, runtime: "podman" }).pipe(
        Effect.provideService(CommandTelemetryAttributes, {
          record: (values) => Ref.update(recorded, (current) => ({ ...current, ...values })),
        }),
      );

      expect(target).toEqual({ projectRoot: root, runtime: "podman", hostRunning: false });
      expect((yield* Ref.get(recorded)).stack_runtime).toBe("podman");
    }).pipe(Effect.provide([BunServices.layer, BunCrypto.layer])),
  );

  it.effect("returns the canonical project root for a new stack reached through a symlink", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { root, resolve } = yield* workspace;
      const link = path.join(root, "link");
      yield* fs.symlink(root, link);

      const target = yield* resolve({ projectRoot: link, runtime: "auto" });

      expect(target.projectRoot).toBe(root);
      expect(target.id).toBeUndefined();
    }).pipe(Effect.provide([BunServices.layer, BunCrypto.layer])),
  );

  it.effect("surfaces an unreadable saved stack instead of reporting it missing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { root, home, register, resolve } = yield* workspace;
      const id = yield* register({ projectRoot: root });
      yield* fs.writeFileString(path.join(home, "stacks", id, "state.json"), "{broken");

      const failure = yield* resolve({ projectRoot: root, runtime: "auto" }).pipe(Effect.flip);

      expect(failure).toBeInstanceOf(StackTargetError);
      expect(failure).toMatchObject({ reason: "invalid-config", targetIssue: "stack-lookup" });
      expect(failure.message).toContain(id);
    }).pipe(Effect.provide([BunServices.layer, BunCrypto.layer])),
  );

  it.effect(
    "tells the user to remove the directory of a saved stack with an unknown service kind",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { root, home, register, resolve } = yield* workspace;
        const id = yield* register({ projectRoot: root });
        const statePath = path.join(home, "stacks", id, "state.json");
        const saved = yield* fs.readFileString(statePath);
        yield* fs.writeFileString(
          statePath,
          saved.replace('"instances":[]', '"instances":[{"id":"logs","service":"vector"}]'),
        );

        const byProject = yield* resolve({ projectRoot: root, runtime: "auto" }).pipe(Effect.flip);
        const byPrefix = yield* resolve({
          projectRoot: root,
          stack: id.slice(0, 8),
          runtime: "auto",
        }).pipe(Effect.flip);

        expect(byProject.targetIssue).toBe("stack-lookup");
        expect(byPrefix.targetIssue).toBe("unreadable-stack");
        for (const failure of [byProject, byPrefix]) {
          expect(failure.reason).toBe("invalid-config");
          expect(failure.message).toContain(`Stack ${id} could not be read`);
          expect(failure.message).toContain(
            `Remove its directory ${path.join(home, "stacks", id)}`,
          );
        }
      }).pipe(Effect.provide([BunServices.layer, BunCrypto.layer])),
  );

  it.effect("reports a stack registry that cannot be read for a name or an id prefix", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { root, home, resolve } = yield* workspace;
      yield* fs.makeDirectory(home);
      yield* fs.writeFileString(path.join(home, "stacks"), "not a directory");

      const byName = yield* resolve({ projectRoot: root, stack: "feature", runtime: "auto" }).pipe(
        Effect.flip,
      );
      /* From a missing project root, an ID-shaped value skips the name lookup. */
      const byPrefix = yield* resolve({
        projectRoot: path.join(root, "missing-current-project"),
        stack: "abcd",
        runtime: "auto",
      }).pipe(Effect.flip);

      expect(byName).toMatchObject({ reason: "invalid-config", targetIssue: "stack-lookup" });
      expect(byPrefix).toMatchObject({ reason: "invalid-config", targetIssue: "stack-discovery" });
    }).pipe(Effect.provide([BunServices.layer, BunCrypto.layer])),
  );

  it.effect("reports a missing project root as the project root, not as a stack lookup", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const { root, resolve } = yield* workspace;

      const failure = yield* resolve({
        projectRoot: path.join(root, "missing-project"),
        runtime: "auto",
      }).pipe(Effect.flip);

      expect(failure).toMatchObject({ reason: "invalid-config", targetIssue: "project-root" });
    }).pipe(Effect.provide([BunServices.layer, BunCrypto.layer])),
  );

  it.effect("surfaces an unreadable saved stack that an id prefix selects", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { root, home, register, resolve } = yield* workspace;
      const id = yield* register({ projectRoot: root });
      yield* fs.writeFileString(path.join(home, "stacks", id, "state.json"), "{broken");

      const failure = yield* resolve({
        projectRoot: root,
        stack: id.slice(0, 8),
        runtime: "auto",
      }).pipe(Effect.flip);

      expect(failure).toMatchObject({ reason: "invalid-config", targetIssue: "unreadable-stack" });
      expect(failure.message).toContain(`Stack ${id} could not be read`);
    }).pipe(Effect.provide([BunServices.layer, BunCrypto.layer])),
  );
});

describe("stack API layer", () => {
  it.effect("creates, discovers, and opens state without starting an owner", () =>
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
    }).pipe(Effect.provide([BunServices.layer, BunCrypto.layer])),
  );
});
