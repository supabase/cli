import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, FileSystem, Option } from "effect";
import { deriveStackId, type StackIdentity } from "../identity/Identity.ts";
import { StackOwnershipConflictError, StackStateInvalidError } from "../public/Errors.ts";
import {
  acquireOwnership,
  controlEndpointFor,
  ownerLockExists,
  publishOwnership,
  readOwnerMetadata,
  type StackRuntimeEnvironmentValue,
} from "./Ownership.ts";
import { makeStackStateStore, type PersistedStackState } from "./StackStateStore.ts";

const withPlatform = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(effect).pipe(Effect.provide(NodeServices.layer));

const identity: StackIdentity = {
  projectRoot: "/tmp/project",
  checkoutRoot: "/tmp/project",
  workspaceId: "/tmp/project",
  checkoutId: "/tmp/project",
  branchContext: "ordinary-workspace",
  localProjectKey: ".",
  stackName: "default",
};

const stateFor = (stackId: string): PersistedStackState => ({
  format: "supabase-stack-state-v1",
  identity: { ...identity, stackId },
  runtime: { kind: "native" },
  desiredGeneration: 0,
  portsGeneration: null,
  desiredLifecycle: "unconfigured",
  ports: [],
  privatePorts: [],
  secrets: {},
});

const errorOf = <E>(exit: Exit.Exit<unknown, E>): E | undefined =>
  Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined;

describe("stack ownership", () => {
  it.live("initializes one complete state for concurrent equivalent creators", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-stack-init-" });
        const stackId = yield* deriveStackId(identity);
        const store = yield* makeStackStateStore({ stateRoot: root });
        const candidate = stateFor(stackId);
        const [first, second] = yield* Effect.all(
          [store.initialize(stackId, candidate), store.initialize(stackId, candidate)],
          { concurrency: 2 },
        );
        expect(first).toEqual(candidate);
        expect(second).toEqual(candidate);
        expect(yield* store.read(stackId)).toEqual(candidate);
      }),
    ),
  );

  it.live("publishes and releases an exact session-fenced owner", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-stack-owner-" });
        const stackId = yield* deriveStackId(identity);
        const environment: StackRuntimeEnvironmentValue = {
          stateRoot: root,
          tempRoot: root,
          platform: "posix",
        };
        const lease = yield* acquireOwnership({
          stateRoot: root,
          stackId,
          ownerSessionId: "session-one",
          rpcRelease: "stack-rpc-v1@0.1.0",
          environment,
        });
        expect(yield* ownerLockExists(root, stackId)).toBe(true);
        expect(lease.metadata.endpoint).toEqual(controlEndpointFor(stackId, environment));
        yield* publishOwnership(lease);
        expect(yield* readOwnerMetadata(root, stackId, environment)).toEqual(lease.metadata);

        const competing = yield* acquireOwnership({
          stateRoot: root,
          stackId,
          ownerSessionId: "session-two",
          rpcRelease: "stack-rpc-v1@0.1.0",
          environment,
        }).pipe(Effect.exit);
        expect(errorOf(competing)).toBeInstanceOf(StackOwnershipConflictError);
        yield* lease.release;
        expect(yield* ownerLockExists(root, stackId)).toBe(false);
        expect(yield* readOwnerMetadata(root, stackId, environment)).toBeUndefined();
      }),
    ),
  );

  it.live("fails closed when owner metadata belongs to another identity", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-stack-fence-" });
        const stackId = yield* deriveStackId(identity);
        const environment: StackRuntimeEnvironmentValue = {
          stateRoot: root,
          tempRoot: root,
          platform: "posix",
        };
        const lease = yield* acquireOwnership({
          stateRoot: root,
          stackId,
          ownerSessionId: "session-one",
          rpcRelease: "stack-rpc-v1@0.1.0",
          environment,
        });
        yield* publishOwnership(lease);
        const metadataPath = lease.metadataPath;
        const text = yield* fs.readFileString(metadataPath);
        yield* fs.writeFileString(metadataPath, text.replace(stackId, "b".repeat(64)));
        const read = yield* readOwnerMetadata(root, stackId, environment).pipe(Effect.exit);
        expect(errorOf(read)).toBeInstanceOf(StackStateInvalidError);
        yield* lease.release;
        // A malformed replacement cannot be removed by this stale finalizer.
        expect(yield* fs.exists(metadataPath)).toBe(true);
      }),
    ),
  );
});
