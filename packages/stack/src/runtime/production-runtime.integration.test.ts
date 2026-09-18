import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Duration, Effect, FileSystem, Path } from "effect";
import { StackIdSchema } from "../public/StackId.ts";
import { ServiceInstanceIdSchema } from "../public/ServiceInstanceId.ts";
import type { PersistedStackState } from "../state/StackState.ts";
import type { PlannedWorkload } from "../model/ExecutionPlan.ts";
import type { RuntimeDriver } from "./RuntimeDriver.ts";
import type { RuntimeEnvFileOwner } from "./RuntimeEnvFile.ts";
import type { FunctionsBootstrapOwner } from "../functions/FunctionsBootstrap.ts";
import {
  readinessDeadlineFor,
  removeOwnedInstancePaths,
  withOwnedRuntimeFileCleanup,
} from "./ProductionRuntime.ts";

const stackId = StackIdSchema.make("a".repeat(64));
const instanceId = ServiceInstanceIdSchema.make("instance");
const state = (runtime: PersistedStackState["runtime"]): PersistedStackState => ({
  format: "supabase-stack-state-v2",
  identity: {
    projectRoot: "/tmp/production-runtime",
    branchContext: "test",
    stackName: "production-runtime",
  },
  runtime,
  preparation: "on-demand",
  security: {
    jwt: {
      issuer: null,
      expirySeconds: 3600,
      signing: { kind: "symmetric", secret: { slot: "secret:auth.jwt" } },
    },
  },
  listeners: {},
  registry: { initialized: true, instances: [], defaultInstanceIds: {} },
  ports: [],
  privatePorts: [],
  secrets: {},
});

const workload: PlannedWorkload = {
  id: `${instanceId}:rest`,
  instanceId,
  recipeId: "rest:rest",
  capability: "rest",
  dependencies: [],
  readiness: { portField: "api" },
  artifacts: {
    native: { kind: "native", release: "12.2.0" },
    container: { kind: "container", image: "postgrest/postgrest:v12.2.0" },
  },
  selected: { kind: "native", release: "12.2.0" },
};

const noOpDriver = (): RuntimeDriver => ({
  observe: () => Effect.succeed([]),
  start: () => Effect.die("unused"),
  stop: () => Effect.die("unused"),
  remove: () => Effect.die("unused"),
  cleanup: () => Effect.void,
  wipePersistentData: () => Effect.die("unused"),
});

const owner = (cleanupAll: Effect.Effect<void>): RuntimeEnvFileOwner => ({
  write: () => Effect.die("unused"),
  cleanupFile: () => Effect.die("unused"),
  cleanupAll,
});

describe("production runtime", () => {
  it.effect("uses the native readiness budget for a native workload", () =>
    Effect.gen(function* () {
      const deadline = yield* readinessDeadlineFor(state({ kind: "native" }), workload);
      expect(Duration.toMillis(deadline)).toBe(120_000);
    }),
  );

  it.effect("uses the container readiness budget for a container workload", () =>
    Effect.gen(function* () {
      const deadline = yield* readinessDeadlineFor(state({ kind: "container", engine: "docker" }), {
        ...workload,
        selected: { kind: "container", image: "postgrest/postgrest:v12.2.0" },
      });
      expect(Duration.toMillis(deadline)).toBe(30_000);
    }),
  );

  it.effect("runs all owner file cleanup after runtime cleanup", () =>
    Effect.gen(function* () {
      const events: string[] = [];
      const files = owner(Effect.sync(() => void events.push("env")));
      const bootstrap: FunctionsBootstrapOwner = {
        write: () => Effect.die("unused"),
        cleanupAll: Effect.sync(() => void events.push("bootstrap")),
      };
      const driver = withOwnedRuntimeFileCleanup(noOpDriver(), files, bootstrap);
      yield* driver.cleanup({ stackId, destroy: false });
      expect(events).toEqual(["env", "bootstrap"]);
    }),
  );

  it.live("removes only the destroyed instance data and runtime roots", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "production-instance-cleanup-" });
      const targetData = path.join(root, "data", "instances", "target");
      const targetRuntime = path.join(root, "runtime", "instances", "target");
      const siblingData = path.join(root, "data", "instances", "sibling");
      const siblingRuntime = path.join(root, "runtime", "instances", "sibling");
      const external = path.join(root, "external-mount");
      yield* Effect.forEach(
        [targetData, targetRuntime, siblingData, siblingRuntime, external],
        (directory) => fs.makeDirectory(directory, { recursive: true }),
        { discard: true },
      );

      yield* removeOwnedInstancePaths(fs, { data: targetData, runtime: targetRuntime });

      expect(yield* fs.exists(targetData)).toBe(false);
      expect(yield* fs.exists(targetRuntime)).toBe(false);
      expect(yield* fs.exists(siblingData)).toBe(true);
      expect(yield* fs.exists(siblingRuntime)).toBe(true);
      expect(yield* fs.exists(external)).toBe(true);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
