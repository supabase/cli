import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, FileSystem, Option, Path, Schema } from "effect";
import { deriveStackId, type StackIdentity } from "../identity/Identity.ts";
import { ServiceInstanceIdSchema } from "../public/ServiceInstanceId.ts";
import { StackStateInvalidError } from "../public/Errors.ts";
import { AUTH_JWT_SECRET_SLOT } from "./SecretStore.ts";
import type { PersistedStackState } from "./StackState.ts";
import { makeStackStateStore } from "./StackStateStore.ts";

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(effect).pipe(Effect.provide(NodeServices.layer));

const candidate = (
  identity: StackIdentity,
  port: number,
  intent: "automatic" | "exact" = "automatic",
): PersistedStackState => ({
  format: "supabase-stack-state-v2",
  identity,
  runtime: { kind: "native" },
  preparation: "on-demand",
  security: {
    jwt: {
      issuer: null,
      expirySeconds: 3_600,
      signing: { kind: "symmetric", secret: { slot: AUTH_JWT_SECRET_SLOT } },
    },
  },
  listeners: { api: { enabled: true, address: "127.0.0.1" } },
  registry: {
    initialized: true,
    instances: [],
    defaultInstanceIds: {},
  },
  ports: [
    {
      owner: "stack",
      binding: "api",
      address: "127.0.0.1",
      port,
      intent,
    },
  ],
  privatePorts: [
    {
      instanceId: ServiceInstanceIdSchema.make("database"),
      workloadId: "database:database",
      binding: "primary",
      port: port + 1,
    },
  ],
  secrets: {},
});

const identity = (root: string, stackName: string): StackIdentity => ({
  projectRoot: `${root}/${stackName}`,
  branchContext: "ordinary-workspace",
  stackName,
});

describe("stable endpoint planning", () => {
  it.live("allocates distinct automatic plans for same-name stacks and retains each plan", () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-port-plans-" });
        const store = yield* makeStackStateStore({ stateRoot: root });
        const firstIdentity = identity(root, "first");
        const secondIdentity = identity(root, "second");
        const firstId = yield* deriveStackId(firstIdentity);
        const secondId = yield* deriveStackId(secondIdentity);
        const first = yield* store.initialize(firstId, candidate(firstIdentity, 21_437));
        const second = yield* store.initialize(secondId, candidate(secondIdentity, 21_437));

        expect(first.ports[0]?.port).toBe(21_437);
        expect(second.ports[0]?.port).not.toBe(first.ports[0]?.port);
        expect(second.privatePorts[0]?.port).not.toBe(first.privatePorts[0]?.port);

        const reopened = yield* store.initialize(
          firstId,
          candidate(firstIdentity, 22_000, "exact"),
        );
        expect(reopened.ports).toEqual(first.ports);
        expect(reopened.privatePorts).toEqual(first.privatePorts);

        const updated = yield* store.update(firstId, (current) => Effect.succeed(current));
        expect(updated.ports).toEqual(first.ports);
        expect(updated.privatePorts).toEqual(first.privatePorts);
      }),
    ),
  );

  it.live(
    "serializes concurrent plans and rejects an exact sibling conflict without publishing",
    () =>
      run(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-port-plan-race-" });
          const store = yield* makeStackStateStore({ stateRoot: root });
          const firstIdentity = identity(root, "first");
          const secondIdentity = identity(root, "second");
          const firstId = yield* deriveStackId(firstIdentity);
          const secondId = yield* deriveStackId(secondIdentity);
          const results = yield* Effect.forEach(
            [
              [firstId, candidate(firstIdentity, 22_100)] as const,
              [secondId, candidate(secondIdentity, 22_100)] as const,
            ],
            ([id, state]) => store.initialize(id, state),
            { concurrency: 2 },
          );
          expect(new Set(results.map((state) => state.ports[0]?.port)).size).toBe(2);

          const conflictIdentity = identity(root, "conflict");
          const conflictId = yield* deriveStackId(conflictIdentity);
          const conflict = yield* store
            .initialize(
              conflictId,
              candidate(conflictIdentity, results[0]?.ports[0]?.port ?? 22_100, "exact"),
            )
            .pipe(Effect.exit);
          expect(Exit.isFailure(conflict)).toBe(true);
          if (Exit.isFailure(conflict))
            expect(Option.getOrUndefined(Cause.findErrorOption(conflict.cause))).toBeInstanceOf(
              StackStateInvalidError,
            );
          expect(yield* store.read(conflictId)).toBeUndefined();

          const firstBefore = yield* store.read(firstId);
          if (firstBefore === undefined)
            return yield* new StackStateInvalidError({ message: "Fixture is incomplete" });
          const foreignIdentity = identity(root, "foreign-conflict");
          const foreignId = yield* deriveStackId(foreignIdentity);
          yield* fs.makeDirectory(path.join(root, foreignId), { recursive: true });
          yield* fs.writeFileString(
            path.join(root, foreignId, "state.json"),
            yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
              candidate(foreignIdentity, firstBefore.ports[0]?.port ?? 22_100),
            ),
          );
          const update = yield* store
            .update(firstId, (current) => Effect.succeed(current))
            .pipe(Effect.exit);
          expect(Exit.isFailure(update)).toBe(true);
          expect(yield* store.read(firstId)).toEqual(firstBefore);
        }),
      ),
  );
});
