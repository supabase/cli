import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path, Scope } from "effect";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- HostListener requires the native server object; Effect HttpClient cannot supply a listener.
import { createServer } from "node:http";
import { deriveStackId, type StackIdentity } from "../identity/Identity.ts";
import { ServiceInstanceIdSchema } from "../public/ServiceInstanceId.ts";
import { emptyServiceRegistry } from "../model/ServiceRegistry.ts";
import { makeStackStateStore, type PersistedStackState } from "./StackStateStore.ts";
import {
  makePortCoordinator,
  type PortCoordinatorOptions,
  type PublicPortIntent,
} from "./PortCoordinator.ts";
import type { HostListener } from "../supervisor/HostListener.ts";
import { AUTH_JWT_SECRET_SLOT } from "./SecretStore.ts";

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(effect).pipe(Effect.provide(NodeServices.layer));

const listener = (
  address: string,
  port: number,
  field: HostListener["field"],
): Effect.Effect<HostListener, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => ({
      address,
      port,
      field,
      binding: { kind: "http" as const, server: createServer() },
      connections: { sockets: new Set() },
      close: Effect.void,
    })),
    (value) => value.close,
  );

const stackState = (identity: StackIdentity): PersistedStackState => ({
  format: "supabase-stack-state-v2",
  identity,
  runtime: { kind: "native" },
  preparation: "on-demand",
  security: {
    jwt: {
      issuer: null,
      expirySeconds: 3600,
      signing: { kind: "symmetric", secret: { slot: AUTH_JWT_SECRET_SLOT } },
    },
  },
  listeners: {},
  registry: emptyServiceRegistry(),
  ports: [],
  privatePorts: [],
  secrets: {},
});

const binding = (id: string): PublicPortIntent => ({
  owner: "instance",
  instanceId: ServiceInstanceIdSchema.make(id),
  binding: "sql",
  address: "127.0.0.1",
  port: "automatic",
});

describe("instance port acquisition", () => {
  it.live("retains one instance binding while allocating a second SQL binding", () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-instance-ports-" });
        const identity = {
          projectRoot: root,
          branchContext: "ordinary-workspace",
          stackName: "ports",
        } satisfies StackIdentity;
        const stackId = yield* deriveStackId(identity);
        const store = yield* makeStackStateStore({ stateRoot: root });
        yield* store.initialize(stackId, stackState(identity));
        const options: PortCoordinatorOptions = {
          stateRoot: root,
          store,
          bindHost: listener,
          bindPrivate: (_address, port) => Effect.succeed({ port, close: Effect.void }),
        };
        const coordinator = makePortCoordinator(options);
        const first = yield* coordinator.acquire(stackId, [binding("db-a")], []);
        const second = yield* coordinator.acquire(stackId, [binding("db-a"), binding("db-b")], []);
        expect(second.privateAssignments).toEqual([]);
        expect(second.assignments["instance:db-a:sql"]?.port).toBe(
          first.assignments["instance:db-a:sql"]?.port,
        );
        expect(second.assignments["instance:db-b:sql"]?.port).toBeDefined();
        expect(second.assignments["instance:db-b:sql"]?.port).not.toBe(
          second.assignments["instance:db-a:sql"]?.port,
        );
        expect((yield* store.read(stackId))?.ports).toHaveLength(2);
      }),
    ),
  );
});
