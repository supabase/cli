import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import {
  Cause,
  Crypto,
  Deferred,
  Effect,
  Exit,
  FileSystem,
  Fiber,
  Option,
  Path,
  Schema,
  Scope,
} from "effect";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- fixture supplies the native HTTP server instance that HostListener and gateways adopt.
import { createServer as createHttpServer } from "node:http";
import { deriveStackId, type StackIdentity } from "../identity/Identity.ts";
import {
  PortAllocationError,
  PortUnavailableError,
  StackStateFormatUnsupportedError,
  StackStateInvalidError,
} from "../public/Errors.ts";
import {
  makePortCoordinator,
  type PublicPortIntent,
  type PortCoordinatorOptions,
} from "./PortCoordinator.ts";
import type { HostListener } from "../supervisor/HostListener.ts";
import { makeStackStateStore, type PersistedStackState } from "./StackStateStore.ts";
import { bindHeldPort, bindHostListener, checkHostPort } from "../supervisor/HostListener.ts";
import { withRegistryLock } from "./StackStateStore.ts";
import { AUTH_JWT_SECRET_SLOT } from "./SecretStore.ts";

const intents = (api: "automatic" | number = "automatic"): ReadonlyArray<PublicPortIntent> => [
  { owner: "stack", binding: "api", address: "127.0.0.1", port: api },
];
const databaseIntent = (port: "automatic" | number = "automatic"): PublicPortIntent => ({
  owner: "instance",
  instanceId: "database-instance",
  binding: "sql",
  listenerField: "database",
  address: "127.0.0.1",
  port,
});

const identity = (root: string, stackName: string): StackIdentity => ({
  projectRoot: root,
  branchContext: "ordinary-workspace",
  stackName,
});

const state = (
  id: string,
  value: StackIdentity,
  ports: PersistedStackState["ports"] = [],
  privatePorts: PersistedStackState["privatePorts"] = [],
): PersistedStackState => ({
  format: "supabase-stack-state-v2",
  identity: value,
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
  registry: { initialized: true, instances: [], defaultInstanceIds: {} },
  ports,
  privatePorts,
  secrets: {},
});

const fakeListener = (
  address: string,
  port: number,
  field: HostListener["field"],
): Effect.Effect<HostListener, PortUnavailableError, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.succeed({
      address,
      port,
      field,
      binding: { kind: "http", server: createHttpServer() },
      connections: { sockets: new Set() },
      close: Effect.void,
    } satisfies HostListener),
    (listener) => listener.close,
  );

const coordinatorOptions = (
  store: PortCoordinatorOptions["store"],
  root: string,
  bindHost = fakeListener,
): PortCoordinatorOptions => ({
  stateRoot: root,
  store,
  bindHost,
  bindPrivate: (_address, port) => Effect.succeed({ port, close: Effect.void }),
});

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(effect).pipe(Effect.provide(NodeServices.layer));
describe("port acquisition", () => {
  it.live("fails closed on an unreadable sibling", () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-ports-state-" });
        const store = yield* makeStackStateStore({ stateRoot: root });
        const value = identity(root, "guard");
        const id = yield* deriveStackId(value);
        yield* store.initialize(id, state(id, value));
        const coordinator = makePortCoordinator(coordinatorOptions(store, root));
        const sibling = yield* deriveStackId(identity(root, "broken"));
        const siblingRoot = path.join(root, sibling);
        yield* fs.makeDirectory(siblingRoot, { recursive: true });
        yield* fs.writeFileString(path.join(siblingRoot, "state.json"), "not-json");
        const result = yield* coordinator.acquire(id, intents(), []).pipe(Effect.exit);
        expect(Exit.isFailure(result)).toBe(true);
        if (Exit.isFailure(result))
          expect(Option.getOrUndefined(Cause.findErrorOption(result.cause))).toBeInstanceOf(
            StackStateInvalidError,
          );
      }),
    ),
  );

  it.live("ignores an empty runtime-only sibling remnant", () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-ports-remnant-" });
        const store = yield* makeStackStateStore({ stateRoot: root });
        const mainIdentity = identity(root, "main");
        const mainId = yield* deriveStackId(mainIdentity);
        const siblingId = yield* deriveStackId(identity(root, "runtime-remnant"));
        yield* store.initialize(mainId, state(mainId, mainIdentity));
        yield* fs.makeDirectory(path.join(root, siblingId, "runtime"), { recursive: true });
        const result = yield* makePortCoordinator(coordinatorOptions(store, root)).acquire(
          mainId,
          intents(),
          [],
        );
        expect(result.assignments.api?.port).toBeGreaterThan(0);
        expect(yield* fs.exists(path.join(root, siblingId, "runtime"))).toBe(true);
        expect(yield* fs.exists(path.join(root, siblingId, "state.json"))).toBe(false);
      }),
    ),
  );

  it.live("preserves unsupported sibling format errors with sibling context", () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-ports-format-" });
        const store = yield* makeStackStateStore({ stateRoot: root });
        const ownIdentity = identity(root, "format-owner");
        const ownId = yield* deriveStackId(ownIdentity);
        const siblingId = yield* deriveStackId(identity(root, "unsupported-sibling"));
        yield* store.initialize(ownId, state(ownId, ownIdentity));
        const siblingState = {
          ...state(siblingId, identity(root, "unsupported-sibling")),
          format: "unsupported-stack-format",
        };
        yield* fs.makeDirectory(path.join(root, siblingId), { recursive: true });
        const encodedSiblingState = yield* Schema.encodeEffect(
          Schema.fromJsonString(Schema.Unknown),
        )(siblingState);
        yield* fs.writeFileString(path.join(root, siblingId, "state.json"), encodedSiblingState);
        const result = yield* makePortCoordinator(coordinatorOptions(store, root))
          .acquire(ownId, intents(), [])
          .pipe(Effect.exit);
        expect(Exit.isFailure(result)).toBe(true);
        if (!Exit.isFailure(result)) return;
        const error = Option.getOrUndefined(Cause.findErrorOption(result.cause));
        expect(error).toBeInstanceOf(StackStateFormatUnsupportedError);
        if (!(error instanceof StackStateFormatUnsupportedError)) return;
        expect(error.format).toBe("unsupported-stack-format");
        expect(error.message).toContain(siblingId);
      }),
    ),
  );

  it.live("excludes automatic and exact durable sibling claims", () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-ports-siblings-" });
        const store = yield* makeStackStateStore({ stateRoot: root });
        const aIdentity = identity(root, "a");
        const bIdentity = identity(root, "b");
        const a = yield* deriveStackId(aIdentity);
        const b = yield* deriveStackId(bIdentity);
        yield* store.initialize(a, state(a, aIdentity));
        yield* store.initialize(b, {
          ...state(b, bIdentity, [
            {
              owner: "stack",
              binding: "api",
              address: "127.0.0.1",
              port: 20_000,
              intent: "automatic",
            },
          ]),
        });
        const coordinator = makePortCoordinator(coordinatorOptions(store, root));
        const automatic = yield* coordinator.acquire(a, intents(), []);
        expect(automatic.assignments.api?.port).not.toBe(20_000);
        yield* store.replaceUnlocked(b, {
          ...state(b, bIdentity, [
            { owner: "stack", binding: "api", address: "127.0.0.1", port: 20_000, intent: "exact" },
          ]),
        });
        const exact = yield* coordinator.acquire(a, intents(20_000), []).pipe(Effect.exit);
        expect(Exit.isFailure(exact)).toBe(true);
        yield* store.replaceUnlocked(b, {
          ...state(b, bIdentity, [
            { owner: "stack", binding: "api", address: "127.0.0.1", port: 20_000, intent: "exact" },
          ]),
        });
        const conflict = yield* coordinator.acquire(a, intents(20_000), []).pipe(Effect.exit);
        expect(Exit.isFailure(conflict)).toBe(true);
      }),
    ),
  );

  it.live("rolls back every bound listener when a later public bind fails", () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-ports-rollback-" });
        const store = yield* makeStackStateStore({ stateRoot: root });
        const value = identity(root, "rollback");
        const id = yield* deriveStackId(value);
        yield* store.initialize(id, state(id, value));
        const listeners: HostListener[] = [];
        const bindHost = (address: string, port: number, field: HostListener["field"]) =>
          field === "database"
            ? Effect.fail(
                new PortUnavailableError({ port, field, message: "injected later bind failure" }),
              )
            : bindHostListener(address, port, field).pipe(
                Effect.tap((listener) => Effect.sync(() => listeners.push(listener))),
              );
        const coordinator = makePortCoordinator(coordinatorOptions(store, root, bindHost));
        const result = yield* coordinator
          .acquire(id, [...intents(), databaseIntent("automatic")], [])
          .pipe(Effect.exit);
        expect(Exit.isFailure(result)).toBe(true);
        expect(listeners).toHaveLength(1);
        expect(listeners.every((listener) => listener.binding.server.listening === false)).toBe(
          true,
        );
        expect((yield* store.read(id))?.ports).toEqual([]);
      }),
    ),
  );
  it.live("retains own automatic ports and excludes every sibling reservation", () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-ports-" });
        const store = yield* makeStackStateStore({ stateRoot: root });
        const aIdentity = identity(root, "a");
        const bIdentity = identity(root, "b");
        const a = yield* deriveStackId(aIdentity);
        const b = yield* deriveStackId(bIdentity);
        yield* store.initialize(a, state(a, aIdentity));
        yield* store.initialize(
          b,
          state(b, bIdentity, [
            {
              owner: "stack",
              binding: "api",
              address: "127.0.0.1",
              port: 20_000,
              intent: "automatic",
            },
          ]),
        );
        const coordinator = makePortCoordinator(coordinatorOptions(store, root));
        const first = yield* coordinator.acquire(a, intents(), []);
        const repeat = yield* coordinator.acquire(a, intents(), []);
        expect(repeat.assignments).toEqual(first.assignments);
        expect(first.assignments.api?.port).not.toBe(20_000);
      }),
    ),
  );

  it.live("preseeds retained ports before allocating a newly enabled earlier field", () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-ports-order-" });
        const store = yield* makeStackStateStore({ stateRoot: root });
        const value = identity(root, "order");
        const id = yield* deriveStackId(value);
        yield* store.initialize(
          id,
          state(id, value, [
            {
              owner: "instance",
              instanceId: "database-instance",
              binding: "sql",
              address: "127.0.0.1",
              port: 20_321,
              intent: "automatic",
            },
          ]),
        );
        const coordinator = makePortCoordinator(coordinatorOptions(store, root));
        const result = yield* coordinator.acquire(
          id,
          [...intents(), databaseIntent("automatic")],
          [],
        );
        expect(result.assignments.database?.port).toBe(20_321);
        expect(result.assignments.api?.port).not.toBe(20_321);
      }),
    ),
  );

  it.live("retains a planned binding when the registry has no started instances", () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-ports-stopped-" });
        const store = yield* makeStackStateStore({ stateRoot: root });
        const value = identity(root, "stopped");
        const id = yield* deriveStackId(value);
        const before = state(id, value, [
          {
            owner: "stack",
            binding: "api",
            address: "127.0.0.1",
            port: 24_001,
            intent: "automatic",
          },
        ]);
        yield* store.initialize(id, before);
        const coordinator = makePortCoordinator(coordinatorOptions(store, root));
        const result = yield* coordinator.acquire(id, intents(), []).pipe(Effect.exit);
        expect(Exit.isSuccess(result)).toBe(true);
        expect((yield* store.read(id))?.ports).toEqual(before.ports);
      }),
    ),
  );

  it.live("keeps durable state unchanged when a public bind fails", () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-ports-failure-" });
        const store = yield* makeStackStateStore({ stateRoot: root });
        const value = identity(root, "failure");
        const id = yield* deriveStackId(value);
        yield* store.initialize(id, state(id, value));
        const bindHost = (_address: string, port: number, field: HostListener["field"]) =>
          Effect.fail(new PortUnavailableError({ port, field, message: "invalid address" }));
        const coordinator = makePortCoordinator(coordinatorOptions(store, root, bindHost));
        const result = yield* coordinator.acquire(id, intents(), []).pipe(Effect.exit);
        expect(Exit.isFailure(result)).toBe(true);
        expect((yield* store.read(id))?.ports).toEqual([]);
      }),
    ),
  );

  it.live("allocates and retains explicit private binding intents in the shared pool", () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-ports-private-" });
        const store = yield* makeStackStateStore({ stateRoot: root });
        const value = identity(root, "private");
        const id = yield* deriveStackId(value);
        yield* store.initialize(id, state(id, value));
        const coordinator = makePortCoordinator(coordinatorOptions(store, root));
        const bindings = [
          { instanceId: "database-instance", workloadId: "database:database", binding: "primary" },
        ];
        const disabledApi: ReadonlyArray<PublicPortIntent> = [];
        const first = yield* coordinator.acquire(id, disabledApi, bindings);
        const second = yield* coordinator.acquire(id, disabledApi, bindings);
        expect(second.privateAssignments).toEqual(first.privateAssignments);
        expect(first.privateAssignments[0]?.port).toBeGreaterThanOrEqual(20_000);
        expect(first.privateAssignments[0]?.port).toBeLessThanOrEqual(32_767);
      }),
    ),
  );

  it.live("persists distinct private bindings and retains them on reacquisition", () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-ports-private-state-" });
        const store = yield* makeStackStateStore({ stateRoot: root });
        const value = identity(root, "private-state");
        const id = yield* deriveStackId(value);
        yield* store.initialize(id, state(id, value));
        const bindings = [
          { instanceId: "database-instance", workloadId: "database:database", binding: "primary" },
          { instanceId: "database-instance", workloadId: "rest:rest", binding: "primary" },
        ];
        const disabled: ReadonlyArray<PublicPortIntent> = [];
        const coordinator = makePortCoordinator({
          ...coordinatorOptions(store, root, bindHostListener),
          bindPrivate: (address, port, _binding) =>
            bindHostListener(address, port, "database").pipe(
              Effect.map((listener) => ({ port: listener.port, close: listener.close })),
            ),
        });
        const first = yield* coordinator.acquire(id, disabled, bindings);
        expect(first.privateAssignments).toHaveLength(2);
        expect(first.privateAssignments[0]?.port).not.toBe(first.privateAssignments[1]?.port);
        expect((yield* store.read(id))?.privatePorts).toEqual(first.privateAssignments);
        const second = yield* coordinator.acquire(id, disabled, bindings);
        expect(second.privateAssignments).toEqual(first.privateAssignments);
      }),
    ),
  );

  it.live("rejects a retained private claim already reserved by another stack", () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-ports-private-conflict-" });
        const store = yield* makeStackStateStore({ stateRoot: root });
        const aIdentity = identity(root, "a");
        const bIdentity = identity(root, "b");
        const a = yield* deriveStackId(aIdentity);
        const b = yield* deriveStackId(bIdentity);
        const assignment = {
          instanceId: "database-instance",
          workloadId: "database:database",
          binding: "primary",
          port: 20_101,
        } as const;
        yield* store.initialize(a, { ...state(a, aIdentity), privatePorts: [assignment] });
        yield* store.initialize(b, {
          ...state(b, bIdentity),
          privatePorts: [{ ...assignment, workloadId: "rest:rest" }],
        });
        // Preserve the malformed sibling fixture to exercise coordinator fail-closed behavior;
        // normal state initialization now prevents publishing this cross-stack collision.
        yield* fs.writeFileString(
          path.join(root, b, "state.json"),
          yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
            ...state(b, bIdentity),
            privatePorts: [{ ...assignment, workloadId: "rest:rest" }],
          }),
        );
        const coordinator = makePortCoordinator(coordinatorOptions(store, root));
        const result = yield* coordinator
          .acquire(
            a,
            [],
            [
              {
                instanceId: "database-instance",
                workloadId: assignment.workloadId,
                binding: assignment.binding,
              },
            ],
          )
          .pipe(Effect.exit);
        expect(Exit.isFailure(result)).toBe(true);
        expect((yield* store.read(a))?.privatePorts).toEqual([assignment]);
      }),
    ),
  );

  it.live("drops a removed private binding after successful acquisition", () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-ports-private-remove-" });
        const store = yield* makeStackStateStore({ stateRoot: root });
        const value = identity(root, "remove");
        const id = yield* deriveStackId(value);
        const previous = {
          instanceId: "database-instance",
          workloadId: "database:database",
          binding: "primary",
          port: 20_102,
        } as const;
        yield* store.initialize(id, { ...state(id, value), privatePorts: [previous] });
        const coordinator = makePortCoordinator(coordinatorOptions(store, root));
        yield* coordinator.acquire(id, [], []);
        expect((yield* store.read(id))?.privatePorts).toEqual([]);
      }),
    ),
  );

  it.live("preseeds exact claims before deterministic fresh allocation", () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-ports-preseed-" });
        const store = yield* makeStackStateStore({ stateRoot: root });
        const value = identity(root, "preseed");
        const id = yield* deriveStackId(value);
        yield* store.initialize(id, state(id, value));
        const crypto = yield* Crypto.Crypto;
        const deterministic = { ...crypto, randomIntBetween: () => Effect.succeed(0) };
        const result = yield* makePortCoordinator(coordinatorOptions(store, root))
          .acquire(id, [...intents(), databaseIntent(20_000)], [])
          .pipe(Effect.provideService(Crypto.Crypto, deterministic));
        expect(result.assignments.database?.port).toBe(20_000);
        expect(result.assignments.api?.port).not.toBe(20_000);
      }),
    ),
  );

  it.live("fails honestly after exactly 64 retryable fresh bind failures", () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-ports-bound-" });
        const store = yield* makeStackStateStore({ stateRoot: root });
        const value = identity(root, "bound");
        const id = yield* deriveStackId(value);
        yield* store.initialize(id, state(id, value));
        let attempts = 0;
        const bindHost = (_address: string, port: number, field: HostListener["field"]) => {
          attempts += 1;
          return Effect.fail(
            new PortUnavailableError({
              port,
              field,
              message: "occupied",
              cause: Object.assign(new Error("occupied"), { code: "EADDRINUSE" }),
            }),
          );
        };
        const crypto = yield* Crypto.Crypto;
        const result = yield* makePortCoordinator(coordinatorOptions(store, root, bindHost))
          .acquire(id, intents(), [])
          .pipe(
            Effect.exit,
            Effect.provideService(Crypto.Crypto, {
              ...crypto,
              randomIntBetween: () => Effect.succeed(0),
            }),
          );
        expect(attempts).toBe(64);
        expect(Exit.isFailure(result)).toBe(true);
        if (Exit.isFailure(result))
          expect(Option.getOrUndefined(Cause.findErrorOption(result.cause))).toBeInstanceOf(
            PortAllocationError,
          );
        expect((yield* store.read(id))?.ports).toEqual([]);
      }),
    ),
  );

  it.live("preserves a nonretryable bind failure without writing state", () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-ports-nonretry-" });
        const store = yield* makeStackStateStore({ stateRoot: root });
        const value = identity(root, "nonretry");
        const id = yield* deriveStackId(value);
        yield* store.initialize(id, state(id, value));
        let attempts = 0;
        const bindHost = (_address: string, port: number, field: HostListener["field"]) => {
          attempts += 1;
          return Effect.fail(
            new PortUnavailableError({
              port,
              field,
              message: "address unavailable",
              cause: Object.assign(new Error("address unavailable"), { code: "EADDRNOTAVAIL" }),
            }),
          );
        };
        const result = yield* makePortCoordinator(coordinatorOptions(store, root, bindHost))
          .acquire(id, intents(), [])
          .pipe(Effect.exit);
        expect(attempts).toBe(1);
        expect(Exit.isFailure(result)).toBe(true);
        if (Exit.isFailure(result))
          expect(Option.getOrUndefined(Cause.findErrorOption(result.cause))).toBeInstanceOf(
            PortUnavailableError,
          );
        expect((yield* store.read(id))?.ports).toEqual([]);
      }),
    ),
  );

  it.live("keeps an earlier successful listener through a later fresh retry", () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-ports-later-retry-" });
        const store = yield* makeStackStateStore({ stateRoot: root });
        const value = identity(root, "later-retry");
        const id = yield* deriveStackId(value);
        yield* store.initialize(id, state(id, value));
        const resources: Array<{ readonly field: string; readonly port: number; closed: boolean }> =
          [];
        let databaseAttempts = 0;
        let apiAttempts = 0;
        const bindHost = (address: string, port: number, field: HostListener["field"]) => {
          if (field === "api") apiAttempts += 1;
          if (field === "database") {
            databaseAttempts += 1;
            if (databaseAttempts === 1)
              return Effect.fail(
                new PortUnavailableError({
                  port,
                  field,
                  message: "occupied",
                  cause: Object.assign(new Error("occupied"), { code: "EACCES" }),
                }),
              );
          }
          const resource = { field, port, closed: false };
          resources.push(resource);
          return Effect.acquireRelease(
            Effect.succeed({
              address,
              port,
              field,
              binding: { kind: "http", server: createHttpServer() },
              connections: { sockets: new Set() },
              close: Effect.sync(() => {
                resource.closed = true;
              }),
            } satisfies HostListener),
            (listener) => listener.close,
          );
        };
        const crypto = yield* Crypto.Crypto;
        const result = yield* makePortCoordinator(coordinatorOptions(store, root, bindHost))
          .acquire(id, [...intents(), databaseIntent("automatic")], [])
          .pipe(
            Effect.provideService(Crypto.Crypto, {
              ...crypto,
              randomIntBetween: () => Effect.succeed(0),
            }),
          );
        expect(result.assignments.api?.port).toBeGreaterThan(0);
        expect(apiAttempts).toBe(1);
        expect(databaseAttempts).toBe(2);
        expect(resources.filter(({ field }) => field === "api")).toHaveLength(1);
        expect(resources.every(({ closed }) => closed === false)).toBe(true);
      }),
    ),
  );

  it.live("binds resources before one failing state write and rolls them all back", () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-ports-write-failure-" });
        const store = yield* makeStackStateStore({ stateRoot: root });
        const value = identity(root, "write-failure");
        const id = yield* deriveStackId(value);
        yield* store.initialize(id, state(id, value));
        let replaceCalls = 0;
        let publicListener: HostListener | undefined;
        let privatePort: number | undefined;
        const failingStore: PortCoordinatorOptions["store"] = {
          ...store,
          replaceUnlocked: (_stackId, next) =>
            Effect.gen(function* () {
              replaceCalls += 1;
              expect(publicListener?.binding.server.listening).toBe(true);
              const assignment = next.privatePorts[0];
              if (assignment === undefined) return yield* Effect.die("missing private assignment");
              privatePort = assignment.port;
              const probe = yield* checkHostPort("127.0.0.1", assignment.port, "database").pipe(
                Effect.exit,
              );
              expect(Exit.isFailure(probe)).toBe(true);
              return yield* new StackStateInvalidError({ message: "injected state write failure" });
            }),
        };
        const coordinator = makePortCoordinator({
          ...coordinatorOptions(failingStore, root, (address, port, field) =>
            bindHostListener(address, port, field).pipe(
              Effect.tap((listener) =>
                Effect.sync(() => {
                  publicListener = listener;
                }),
              ),
            ),
          ),
          bindPrivate: (address, port, binding) => bindHeldPort(address, port, binding),
        });
        const result = yield* coordinator
          .acquire(
            id,
            [...intents(), databaseIntent("automatic")],
            [
              {
                instanceId: "database-instance",
                workloadId: "database:database",
                binding: "primary",
              },
            ],
          )
          .pipe(Effect.exit);
        expect(Exit.isFailure(result)).toBe(true);
        expect(replaceCalls).toBe(1);
        expect(publicListener?.binding.server.listening).toBe(false);
        expect(privatePort).toBeDefined();
        expect((yield* store.read(id))?.ports).toEqual([]);
        expect((yield* store.read(id))?.privatePorts).toEqual([]);
      }),
    ),
  );

  it.live("interrupts a waiting transaction and releases its first bound socket", () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-ports-interrupt-" });
        const store = yield* makeStackStateStore({ stateRoot: root });
        const value = identity(root, "interrupt");
        const id = yield* deriveStackId(value);
        const before = state(id, value, [
          {
            owner: "instance",
            instanceId: "studio-instance",
            binding: "studio",
            address: "127.0.0.1",
            port: 20_103,
            intent: "automatic",
          },
        ]);
        yield* store.initialize(id, before);
        const parentScope = yield* Scope.Scope;
        const acquisitionScope = yield* Scope.fork(parentScope, "sequential");
        const waiting = yield* Deferred.make<void>();
        let publicListener: HostListener | undefined;
        const coordinator = makePortCoordinator({
          ...coordinatorOptions(store, root, (address, port, field) =>
            field === "api"
              ? bindHostListener(address, port, field).pipe(
                  Effect.tap((listener) =>
                    Effect.sync(() => {
                      publicListener = listener;
                    }),
                  ),
                )
              : Effect.gen(function* () {
                  yield* Deferred.succeed(waiting, undefined);
                  return yield* Effect.never;
                }),
          ),
          bindPrivate: (_address, _port, _binding) => Effect.never,
        });
        const fiber = yield* Effect.forkChild(
          coordinator
            .acquire(id, [...intents(), databaseIntent("automatic")], [])
            .pipe(Effect.provideService(Scope.Scope, acquisitionScope)),
          { startImmediately: true },
        );
        yield* Deferred.await(waiting);
        yield* Fiber.interrupt(fiber);
        expect(publicListener?.binding.server.listening).toBe(false);
        expect((yield* store.read(id))?.ports).toEqual(before.ports);
        yield* withRegistryLock(root, Effect.succeed(true));
        yield* Scope.close(acquisitionScope, Exit.void);
      }),
    ),
  );

  it.live("finishes a commit after interruption is requested", () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-ports-commit-interrupt-" });
        const store = yield* makeStackStateStore({ stateRoot: root });
        const value = identity(root, "commit-interrupt");
        const id = yield* deriveStackId(value);
        yield* store.initialize(id, state(id, value));
        const commitStarted = yield* Deferred.make<void>();
        const releaseCommit = yield* Deferred.make<void>();
        const committingStore: PortCoordinatorOptions["store"] = {
          ...store,
          replaceUnlocked: (stackId, next) =>
            Effect.gen(function* () {
              const result = yield* store.replaceUnlocked(stackId, next);
              yield* Deferred.succeed(commitStarted, undefined);
              yield* Deferred.await(releaseCommit);
              return result;
            }),
        };
        const parentScope = yield* Scope.Scope;
        const acquisitionScope = yield* Scope.fork(parentScope, "sequential");
        let publicListener: HostListener | undefined;
        const coordinator = makePortCoordinator(
          coordinatorOptions(committingStore, root, (address, port, field) =>
            bindHostListener(address, port, field).pipe(
              Effect.tap((listener) =>
                Effect.sync(() => {
                  publicListener = listener;
                }),
              ),
            ),
          ),
        );
        const fiber = yield* Effect.forkChild(
          coordinator
            .acquire(id, intents(), [])
            .pipe(Effect.provideService(Scope.Scope, acquisitionScope)),
          { startImmediately: true },
        );
        yield* Deferred.await(commitStarted);
        const interrupt = yield* Effect.forkChild(Fiber.interrupt(fiber), {
          startImmediately: true,
        });
        yield* Deferred.succeed(releaseCommit, undefined);
        yield* Fiber.join(fiber).pipe(Effect.exit);
        yield* Fiber.join(interrupt);
        expect((yield* store.read(id))?.ports).toHaveLength(1);
        expect(publicListener?.binding.server.listening).toBe(true);
        yield* Scope.close(acquisitionScope, Exit.void);
        expect(publicListener?.binding.server.listening).toBe(false);
      }),
    ),
  );
});
