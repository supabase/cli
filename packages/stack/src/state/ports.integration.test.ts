import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, FileSystem, Option, Scope } from "effect";
import { createServer, type Server } from "node:net";
import { deriveStackId, type StackIdentity } from "../identity/Identity.ts";
import {
  PortAllocationError,
  PortUnavailableError,
  StackLifecycleConflictError,
} from "../public/Errors.ts";
import { makePortRegistry } from "./PortRegistry.ts";
import { makePortCoordinator, type ListenerIntents } from "./PortCoordinator.ts";
import { makeStackStateStore, type PersistedStackState } from "./StackStateStore.ts";

const layer = NodeServices.layer;
const intents = (port: "automatic" | number): ListenerIntents => ({
  api: { enabled: true, address: "127.0.0.1", port },
  database: { enabled: true, address: "127.0.0.1", port: "automatic" },
  pooler: { enabled: false, address: "127.0.0.1", port: "automatic" },
  studio: { enabled: false, address: "127.0.0.1", port: "automatic" },
  mailUi: { enabled: false, address: "127.0.0.1", port: "automatic" },
  smtp: { enabled: false, address: "127.0.0.1", port: "automatic" },
  pop3: { enabled: false, address: "127.0.0.1", port: "automatic" },
  functionsInspector: { enabled: false, address: "127.0.0.1", port: "automatic" },
});
const disabledIntents = (): ListenerIntents => ({
  api: { enabled: false, address: "127.0.0.1", port: "automatic" },
  database: { enabled: false, address: "127.0.0.1", port: "automatic" },
  pooler: { enabled: false, address: "127.0.0.1", port: "automatic" },
  studio: { enabled: false, address: "127.0.0.1", port: "automatic" },
  mailUi: { enabled: false, address: "127.0.0.1", port: "automatic" },
  smtp: { enabled: false, address: "127.0.0.1", port: "automatic" },
  pop3: { enabled: false, address: "127.0.0.1", port: "automatic" },
  functionsInspector: { enabled: false, address: "127.0.0.1", port: "automatic" },
});
const baseState = (
  stackId: string,
  identity: StackIdentity,
  desiredLifecycle: "stopped" | "running" = "stopped",
): PersistedStackState => ({
  format: "supabase-stack-state-v1",
  identity: {
    ...identity,
    stackId,
  },
  runtime: { kind: "native" },
  desiredGeneration: 0,
  desiredLifecycle,
  ports: [],
  secrets: {},
});
const errorOf = <E>(exit: Exit.Exit<unknown, E>): E | undefined =>
  Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined;
const withPlatform = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(effect).pipe(Effect.provide(layer));

const makeIdentity = (root: string, name: string): StackIdentity => ({
  projectRoot: root,
  checkoutRoot: root,
  workspaceId: root,
  checkoutId: root,
  branchContext: "ordinary-workspace",
  localProjectKey: ".",
  stackName: name,
});

const holdHostPort = (port: number): Effect.Effect<Server, Error, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.callback<Server, Error>((resume) => {
      const server = createServer();
      const onError = (error: Error) => {
        server.removeListener("error", onError);
        resume(Effect.fail(error));
      };
      server.once("error", onError);
      server.listen({ host: "127.0.0.1", port }, () => {
        server.removeListener("error", onError);
        resume(Effect.succeed(server));
      });
      return Effect.sync(() => {
        server.removeListener("error", onError);
        server.close();
      });
    }),
    (server) =>
      Effect.callback<void, never>((resume) => {
        if (!server.listening) {
          resume(Effect.void);
          return;
        }
        server.close(() => resume(Effect.void));
      }),
  );

describe("sticky port coordination", () => {
  it.live("keeps automatic assignments sticky and exclusive", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-stack-port-" });
        const store = yield* makeStackStateStore({ stateRoot: root });
        const aIdentity = makeIdentity(root, "a");
        const bIdentity = makeIdentity(root, "b");
        const a = yield* deriveStackId(aIdentity);
        const b = yield* deriveStackId(bIdentity);
        yield* store.write(a, baseState(a, aIdentity));
        yield* store.write(b, baseState(b, bIdentity));
        const registry = yield* makePortRegistry({ stateRoot: root, store });
        const coordinator = makePortCoordinator(registry, store);
        const first = yield* coordinator.planAndReserve(a, intents("automatic"));
        const repeat = yield* coordinator.planAndReserve(a, intents("automatic"));
        expect(repeat.assignments).toEqual(first.assignments);
        const second = yield* coordinator.planAndReserve(b, intents("automatic"));
        expect(second.assignments.api?.port).not.toBe(first.assignments.api?.port);
      }),
    ),
  );

  it.live("rejects an exact request for another stack's automatic assignment", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "supabase-stack-port-auto-exact-",
        });
        const store = yield* makeStackStateStore({ stateRoot: root });
        const aIdentity = makeIdentity(root, "automatic-owner");
        const bIdentity = makeIdentity(root, "exact-requester");
        const a = yield* deriveStackId(aIdentity);
        const b = yield* deriveStackId(bIdentity);
        yield* store.write(a, baseState(a, aIdentity));
        yield* store.write(b, baseState(b, bIdentity));
        const registry = yield* makePortRegistry({ stateRoot: root, store });
        const coordinator = makePortCoordinator(registry, store);
        const automatic = yield* coordinator.planAndReserve(a, intents("automatic"));
        const occupied = automatic.assignments.api?.port;
        expect(occupied).toBeTypeOf("number");
        if (occupied === undefined) return;
        const exit = yield* coordinator
          .planAndReserve(
            b,
            {
              ...disabledIntents(),
              api: { enabled: true, address: "127.0.0.1", port: occupied },
            },
            { lifecycle: "stopped" },
          )
          .pipe(Effect.exit);
        expect(errorOf(exit)).toBeInstanceOf(PortAllocationError);
        expect(yield* registry.assignments(b)).toEqual([]);
      }),
    ),
  );

  it.live("rejects assignment changes while a stack is running", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-stack-port-running-" });
        const store = yield* makeStackStateStore({ stateRoot: root });
        const exactIdentity = makeIdentity(root, "running-exact");
        const automaticIdentity = makeIdentity(root, "running-automatic");
        const exactId = yield* deriveStackId(exactIdentity);
        const automaticId = yield* deriveStackId(automaticIdentity);
        yield* store.write(exactId, {
          ...baseState(exactId, exactIdentity, "running"),
          desiredGeneration: 7,
          ports: [{ field: "api", port: 55435, intent: "exact" }],
        });
        yield* store.write(automaticId, {
          ...baseState(automaticId, automaticIdentity, "running"),
          desiredGeneration: 9,
          ports: [{ field: "api", port: 55436, intent: "automatic" }],
        });
        const registry = yield* makePortRegistry({ stateRoot: root, store });
        const coordinator = makePortCoordinator(registry, store);
        const exactToDifferent = yield* coordinator
          .planAndReserve(
            exactId,
            {
              ...disabledIntents(),
              api: { enabled: true, address: "127.0.0.1", port: 55437 },
            },
            { lifecycle: "running", runtime: { kind: "native" } },
          )
          .pipe(Effect.exit);
        expect(errorOf(exactToDifferent)).toBeInstanceOf(StackLifecycleConflictError);
        expect((yield* store.read(exactId))?.desiredGeneration).toBe(7);

        const automaticToExact = yield* coordinator
          .planAndReserve(
            automaticId,
            {
              ...disabledIntents(),
              api: { enabled: true, address: "127.0.0.1", port: 55438 },
            },
            { lifecycle: "running", runtime: { kind: "native" } },
          )
          .pipe(Effect.exit);
        expect(errorOf(automaticToExact)).toBeInstanceOf(StackLifecycleConflictError);
        expect((yield* store.read(automaticId))?.desiredGeneration).toBe(9);
      }),
    ),
  );

  it.live("keeps an unchanged running assignment without advancing generation", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "supabase-stack-port-running-repeat-",
        });
        const store = yield* makeStackStateStore({ stateRoot: root });
        const identity = makeIdentity(root, "running-repeat");
        const stackId = yield* deriveStackId(identity);
        yield* store.write(stackId, {
          ...baseState(stackId, identity, "running"),
          desiredGeneration: 11,
          ports: [{ field: "api", port: 55439, intent: "exact" }],
        });
        const registry = yield* makePortRegistry({ stateRoot: root, store });
        const coordinator = makePortCoordinator(registry, store, {
          bindNative: (address, port, field) =>
            Effect.succeed({
              address,
              port,
              field,
              close: Effect.void,
            }),
        });
        const result = yield* coordinator.planAndReserve(
          stackId,
          {
            ...disabledIntents(),
            api: { enabled: true, address: "127.0.0.1", port: 55439 },
          },
          { lifecycle: "running", runtime: { kind: "native" } },
        );
        expect(result.assignments.api?.port).toBe(55439);
        expect((yield* store.read(stackId))?.desiredGeneration).toBe(11);
      }),
    ),
  );

  it.live("allows exact assignments to coexist while stopped but rejects live conflicts", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-stack-port-exact-" });
        const store = yield* makeStackStateStore({ stateRoot: root });
        const cIdentity = makeIdentity(root, "c");
        const dIdentity = makeIdentity(root, "d");
        const c = yield* deriveStackId(cIdentity);
        const d = yield* deriveStackId(dIdentity);
        yield* store.write(c, {
          ...baseState(c, cIdentity, "running"),
          ports: [{ field: "api", port: 55432, intent: "exact" }],
        });
        yield* store.write(d, baseState(d, dIdentity));
        const registry = yield* makePortRegistry({ stateRoot: root, store });
        const coordinator = makePortCoordinator(registry, store);
        yield* coordinator.planAndReserve(d, intents(55432), { lifecycle: "stopped" });
        const conflict = yield* coordinator
          .planAndReserve(d, intents(55432), { lifecycle: "running" })
          .pipe(Effect.exit);
        expect(errorOf(conflict)).toBeInstanceOf(PortUnavailableError);
      }),
    ),
  );

  it.live("rejects duplicate exact ports within one stack", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "supabase-stack-port-duplicate-",
        });
        const store = yield* makeStackStateStore({ stateRoot: root });
        const identity = makeIdentity(root, "duplicate");
        const stackId = yield* deriveStackId(identity);
        yield* store.write(stackId, baseState(stackId, identity));
        const registry = yield* makePortRegistry({ stateRoot: root, store });
        const coordinator = makePortCoordinator(registry, store);
        const exit = yield* coordinator
          .planAndReserve(
            stackId,
            {
              ...disabledIntents(),
              api: { enabled: true, address: "127.0.0.1", port: 55434 },
              database: { enabled: true, address: "127.0.0.1", port: 55434 },
            },
            { lifecycle: "stopped" },
          )
          .pipe(Effect.exit);
        expect(errorOf(exit)).toBeInstanceOf(PortUnavailableError);
      }),
    ),
  );

  it.live("rejects an exact port occupied by an owned host listener", () =>
    withPlatform(
      Effect.gen(function* () {
        const root = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({
          prefix: "supabase-stack-port-host-",
        });
        const store = yield* makeStackStateStore({ stateRoot: root });
        const identity = makeIdentity(root, "host-conflict");
        const stackId = yield* deriveStackId(identity);
        yield* store.write(stackId, baseState(stackId, identity));
        const host = yield* holdHostPort(0);
        const hostAddress = host.address();
        expect(hostAddress).toBeTypeOf("object");
        if (typeof hostAddress !== "object" || hostAddress === null) return;
        const occupiedPort = hostAddress.port;
        const registry = yield* makePortRegistry({ stateRoot: root, store });
        const coordinator = makePortCoordinator(registry, store, {
          bindNative: (address, port, field) =>
            holdHostPort(port).pipe(
              Effect.map((server) => ({
                field,
                address,
                port,
                close: Effect.sync(() => server.close()),
              })),
              Effect.mapError(
                () =>
                  new PortUnavailableError({
                    port,
                    field,
                    message: "host listener already owns port",
                  }),
              ),
            ),
        });
        const exit = yield* coordinator
          .planAndReserve(
            stackId,
            {
              ...disabledIntents(),
              api: { enabled: true, address: "127.0.0.1", port: occupiedPort },
            },
            { lifecycle: "running", runtime: { kind: "native" } },
          )
          .pipe(Effect.exit);
        expect(errorOf(exit)).toBeInstanceOf(PortUnavailableError);
        expect(
          (yield* registry.assignments(stackId)).some(
            (assignment) => assignment.port === occupiedPort,
          ),
        ).toBe(true);
      }),
    ),
  );

  it.live("transfers native sockets without a bind-close-rebind", () =>
    Effect.gen(function* () {
      const bound = new Set<number>();
      let closed = 0;
      yield* withPlatform(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-stack-port-native-" });
          const store = yield* makeStackStateStore({ stateRoot: root });
          const eIdentity = makeIdentity(root, "e");
          const e = yield* deriveStackId(eIdentity);
          yield* store.write(e, baseState(e, eIdentity));
          const registry = yield* makePortRegistry({ stateRoot: root, store });
          const coordinator = makePortCoordinator(registry, store, {
            bindNative: (address, port, field) =>
              bound.has(port)
                ? Effect.fail(new PortUnavailableError({ port, field, message: "already bound" }))
                : Effect.acquireRelease(
                    Effect.sync(() => {
                      bound.add(port);
                      return {
                        address,
                        port,
                        field,
                        close: Effect.sync(() => {
                          bound.delete(port);
                          closed += 1;
                        }),
                      };
                    }),
                    (listener) => listener.close,
                  ),
          });
          const result = yield* coordinator.planAndReserve(e, intents("automatic"), {
            lifecycle: "running",
            runtime: { kind: "native" },
          });
          expect(result.nativeListeners).toHaveLength(2);
          expect(closed).toBe(0);
          expect(bound.size).toBe(2);
        }),
      );
      expect(closed).toBe(2);
      expect(bound.size).toBe(0);
    }),
  );

  it.live("releases earlier native listeners when a later bind fails", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "supabase-stack-port-native-failure-",
        });
        const store = yield* makeStackStateStore({ stateRoot: root });
        const identity = makeIdentity(root, "native-failure");
        const stackId = yield* deriveStackId(identity);
        yield* store.write(stackId, baseState(stackId, identity));
        const registry = yield* makePortRegistry({ stateRoot: root, store });
        const bound = new Set<number>();
        let attempts = 0;
        const coordinator = makePortCoordinator(registry, store, {
          bindNative: (address, port, field) => {
            attempts += 1;
            if (attempts === 2)
              return Effect.fail(
                new PortUnavailableError({ port, field, message: "simulated second bind failure" }),
              );
            return Effect.acquireRelease(
              Effect.sync(() => {
                bound.add(port);
                return {
                  address,
                  port,
                  field,
                  close: Effect.sync(() => {
                    bound.delete(port);
                  }),
                };
              }),
              (listener) => listener.close,
            );
          },
        });
        const exit = yield* coordinator
          .planAndReserve(stackId, intents("automatic"), {
            lifecycle: "running",
            runtime: { kind: "native" },
          })
          .pipe(Effect.exit);
        expect(errorOf(exit)).toBeInstanceOf(PortUnavailableError);
        expect(bound).toHaveLength(0);
      }),
    ),
  );

  it.live("retains a chosen assignment when container publication races", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-stack-port-race-" });
        const store = yield* makeStackStateStore({ stateRoot: root });
        const fIdentity = makeIdentity(root, "f");
        const f = yield* deriveStackId(fIdentity);
        yield* store.write(f, baseState(f, fIdentity));
        const registry = yield* makePortRegistry({ stateRoot: root, store });
        const coordinator = makePortCoordinator(registry, store, {
          publishContainer: (address, port, field) =>
            Effect.fail(new PortUnavailableError({ port, field, message: `race at ${address}` })),
        });
        const exit = yield* coordinator
          .planAndReserve(f, intents(55433), {
            lifecycle: "running",
            runtime: { kind: "container", engine: "docker" },
          })
          .pipe(Effect.exit);
        expect(errorOf(exit)).toBeInstanceOf(PortUnavailableError);
        const reserved = yield* registry.assignments(f);
        expect(reserved.some((assignment) => assignment.port === 55433)).toBe(true);
      }),
    ),
  );
});
