import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Context, Crypto, Effect, FileSystem, Path, Schema } from "effect";
import { compileServiceInstance } from "../model/Compiler.ts";
import { StackStatusSchema } from "../public/Status.ts";
import { StackIdSchema } from "../public/StackId.ts";
import { ServiceInstanceIdSchema } from "../public/ServiceInstanceId.ts";
import type { PersistedStackState } from "../state/StackState.ts";
import { statusForPersistedState } from "./StatusProjection.ts";

const stackId = StackIdSchema.make(
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
);

const withPlatform = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(effect).pipe(Effect.provide(NodeServices.layer));

describe("persisted status projection", { timeout: 30_000 }, () => {
  it.live("omits a destroyed default and preserves the live default instance id", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const crypto = yield* Crypto.Crypto;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-status-projection-" });
        const context = Context.make(FileSystem.FileSystem, fs).pipe(
          Context.add(Path.Path, path),
          Context.add(Crypto.Crypto, crypto),
        );
        const database = yield* compileServiceInstance(
          { service: "database", config: {} },
          {
            projectRoot: root,
            path,
            runtime: { kind: "native" },
          },
        ).pipe(Effect.provideContext(context));
        const dynamicId = ServiceInstanceIdSchema.make("11111111-1111-4111-8111-111111111111");
        const state = (
          instances: PersistedStackState["registry"]["instances"],
          defaults: PersistedStackState["registry"]["defaultInstanceIds"],
          includePorts = true,
        ): PersistedStackState => ({
          format: "supabase-stack-state-v2",
          identity: { projectRoot: root, branchContext: "test", stackName: "status" },
          runtime: { kind: "native" },
          preparation: "on-demand",
          security: {
            jwt: {
              issuer: null,
              expirySeconds: 3600,
              signing: { kind: "symmetric", secret: { slot: "test-jwt" } },
            },
          },
          listeners: { api: { enabled: true, address: "127.0.0.1" } },
          registry: { initialized: true, instances, defaultInstanceIds: defaults },
          ports: includePorts
            ? [
                {
                  owner: "stack",
                  binding: "api",
                  address: "127.0.0.1",
                  port: 54321,
                  intent: "automatic",
                },
                ...(
                  [
                    ["sql", 55432],
                    ["pooler", 65432],
                    ["studio", 3000],
                    ["mailUi", 4000],
                    ["smtp", 2525],
                    ["pop3", 3110],
                    ["inspector", 8081],
                  ] as const
                ).map(([binding, port]) => ({
                  owner: "instance" as const,
                  instanceId: database.id,
                  binding,
                  address: "127.0.0.1",
                  port,
                  intent: "automatic" as const,
                })),
                {
                  owner: "instance",
                  instanceId: dynamicId,
                  binding: "sql",
                  address: "127.0.0.1",
                  port: 55433,
                  intent: "automatic",
                },
              ]
            : [],
          privatePorts: [],
          secrets: { "test-jwt": { policy: "managed", value: "test" } },
        });

        const live = yield* statusForPersistedState(
          stackId,
          state([{ ...database.instance, id: dynamicId }, database.instance], {
            database: database.id,
          }),
        );
        const decodedLive = yield* Schema.decodeEffect(StackStatusSchema)(live);
        expect(decodedLive.capabilities).toEqual([
          expect.objectContaining({ name: "database", id: database.id }),
        ]);
        expect(decodedLive.endpoints).toEqual({
          api: expect.objectContaining({ protocol: "http", port: 54321 }),
          database: expect.objectContaining({ protocol: "tcp", port: 55432 }),
          pooler: expect.objectContaining({ protocol: "tcp", port: 65432 }),
          studio: expect.objectContaining({ protocol: "http", port: 3000 }),
          mailUi: expect.objectContaining({ protocol: "http", port: 4000 }),
          smtp: expect.objectContaining({ protocol: "tcp", port: 2525 }),
          pop3: expect.objectContaining({ protocol: "tcp", port: 3110 }),
          functionsInspector: expect.objectContaining({ protocol: "http", port: 8081 }),
        });
        expect(decodedLive.endpoints.database?.port).toBe(55432);
        expect(decodedLive.instances.find(({ id }) => id === dynamicId)?.endpoints).toEqual([
          expect.objectContaining({ binding: "sql", port: 55433 }),
        ]);

        const destroyed = yield* statusForPersistedState(stackId, state([], {}, false));
        const decodedDestroyed = yield* Schema.decodeEffect(StackStatusSchema)(destroyed);
        expect(decodedDestroyed.capabilities).toEqual([]);
      }),
    ),
  );
});
