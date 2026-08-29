import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path, Crypto, Stream } from "effect";
import type { StackLogEntry } from "../public/Logs.ts";
import { StackIdSchema } from "../public/StackId.ts";
import type { PersistedStackState } from "../state/StackState.ts";
import type { StackStateStore } from "../state/StackStateStore.ts";
import type { SupervisorIngress } from "../supervisor/Ingress.ts";
import type { LogStore } from "../supervisor/LogStore.ts";
import { makeProductionRuntimeFactory } from "./ProductionRuntime.ts";
import type { RuntimeArtifactPreparer } from "../preparation/RuntimeArtifacts.ts";
import type { RuntimeEnvFileOwner } from "./RuntimeEnvFile.ts";
import type { FunctionsBootstrapOwner } from "../functions/FunctionsBootstrap.ts";

const stackId = StackIdSchema.make("a".repeat(64));

const stateFor = (secrets: PersistedStackState["secrets"]): PersistedStackState => ({
  format: "supabase-stack-state-v1",
  identity: {
    stackId,
    projectRoot: "/tmp/production-runtime",
    checkoutRoot: "/tmp/production-runtime",
    workspaceId: "/tmp/production-runtime",
    checkoutId: "/tmp/production-runtime",
    branchContext: "ordinary-workspace",
    localProjectKey: ".",
    stackName: "production-runtime",
  },
  runtime: { kind: "native" },
  desiredGeneration: 1,
  portsGeneration: null,
  desiredLifecycle: "stopped",
  ports: [],
  privatePorts: [],
  secrets,
});

const stateStoreFor = (current: { value: PersistedStackState }): StackStateStore => ({
  read: () => Effect.sync(() => current.value),
  write: () => Effect.die("unused"),
  initialize: () => Effect.die("unused"),
  replace: () => Effect.die("unused"),
  replaceUnlocked: () => Effect.die("unused"),
  cleanup: () => Effect.die("unused"),
});

const memoryLogStore = (entries: StackLogEntry[]): LogStore => ({
  path: "memory://production-runtime",
  append: (record) =>
    Effect.sync(() => {
      const entry: StackLogEntry = {
        cursor: { opaque: `v1_${entries.length + 1}` },
        timestamp: record.timestamp ?? "2026-01-01T00:00:00.000Z",
        source: record.source,
        stream: record.stream,
        message: record.message,
      };
      entries.push(entry);
      return entry;
    }),
  read: () => Effect.succeed(entries),
  retained: () => Effect.succeed(entries),
  stream: () => Stream.fromIterable(entries),
});

const ingress: SupervisorIngress = {
  acquire: () => Effect.die("unused"),
  open: () => Effect.die("unused"),
  close: Effect.void,
};

const artifacts: RuntimeArtifactPreparer = {
  prepare: () => Effect.die("unused"),
};

const envFiles: RuntimeEnvFileOwner = {
  write: () => Effect.die("unused"),
  cleanupGeneration: () => Effect.void,
  cleanupAll: Effect.void,
};

const bootstrap: FunctionsBootstrapOwner = {
  write: () => Effect.die("unused"),
  cleanupGeneration: () => Effect.void,
};

describe("production runtime composition", () => {
  it.live("redacts logs using secret slots materialized after factory creation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const current = { value: stateFor({}) };
        const entries: StackLogEntry[] = [];
        const context = yield* Effect.context<FileSystem.FileSystem | Path.Path | Crypto.Crypto>();
        const factory = yield* makeProductionRuntimeFactory({
          stateRoot: "/tmp/production-runtime-state",
          stackId,
          ownerSessionId: "owner",
          stateStore: stateStoreFor(current),
          context,
          ingress,
          artifactPreparer: artifacts,
          envFileOwner: envFiles,
          functionsBootstrapOwner: bootstrap,
          logStore: memoryLogStore(entries),
          bootstrapDatabase: () => Effect.void,
        });
        const runtime = yield* factory.make(current.value);
        current.value = stateFor({
          "secret:auth.settings.jwt_secret": { policy: "managed", value: "rotated-secret" },
        });
        const logStore = runtime.logStore;
        expect(logStore).toBeDefined();
        if (logStore === undefined) return;
        yield* logStore.append({
          source: "auth",
          stream: "stdout",
          message: "token=rotated-secret",
        });
        expect(entries[0]?.message).toBe("token=[REDACTED]");
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );
});
