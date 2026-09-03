import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, FileSystem, Option, Scope } from "effect";
import { createServer, type Server } from "node:net";
// oxlint-disable-next-line effecttsgo/node-builtin-import
import { createServer as createHttpServer } from "node:http";
import { deriveStackId, type StackIdentity } from "../identity/Identity.ts";
import { PortAllocationError, PortUnavailableError } from "../public/Errors.ts";
import { makePortCoordinator, type HostListener, type ListenerIntents } from "./PortCoordinator.ts";
import { makeStackStateStore, type PersistedStackState } from "./StackStateStore.ts";
import { bindHostListener } from "../supervisor/HostListener.ts";

const layer = NodeServices.layer;
const successfulHostPortCheck = (_address: string, _port: number, _field: string) => Effect.void;
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
  desiredLifecycle,
  ports: [],
  privatePorts: [],
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
      const server = createServer({ allowHalfOpen: true });
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

const makeTestHostListener = (
  address: string,
  port: number,
  field: HostListener["field"],
  hooks: { readonly onClose?: () => void } = {},
): Effect.Effect<HostListener, PortUnavailableError, Scope.Scope> => {
  const isHttp =
    field === "api" || field === "studio" || field === "mailUi" || field === "functionsInspector";
  if (isHttp)
    return Effect.acquireRelease(
      Effect.gen(function* () {
        const server = createHttpServer();
        const close = yield* Effect.cached(
          Effect.sync(() => {
            if (server.listening) server.close();
            hooks.onClose?.();
          }),
        );
        return {
          address,
          port,
          field,
          binding: { kind: "http", server },
          close,
        } satisfies HostListener;
      }),
      (listener) => listener.close,
    );
  return Effect.acquireRelease(
    Effect.gen(function* () {
      const server = createServer({ allowHalfOpen: true });
      const close = yield* Effect.cached(
        Effect.sync(() => {
          if (server.listening) server.close();
          hooks.onClose?.();
        }),
      );
      return {
        address,
        port,
        field,
        binding: { kind: "tcp", server, allowHalfOpen: true },
        close,
      } satisfies HostListener;
    }),
    (listener) => listener.close,
  );
};

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
        yield* store.initialize(a, baseState(a, aIdentity));
        yield* store.initialize(b, baseState(b, bIdentity));
        const coordinator = makePortCoordinator({
          stateRoot: root,
          store,
          checkHostPort: successfulHostPortCheck,
          bindHost: makeTestHostListener,
        });
        const first = yield* coordinator.planAndReserve(a, intents("automatic"));
        const repeat = yield* coordinator.planAndReserve(a, intents("automatic"));
        expect(repeat.assignments).toEqual(first.assignments);
        const second = yield* coordinator.planAndReserve(b, intents("automatic"));
        expect(second.assignments.api?.port).not.toBe(first.assignments.api?.port);
      }),
    ),
  );

  it.live("skips foreign listeners while selecting fresh automatic ports", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-stack-port-probe-" });
        const store = yield* makeStackStateStore({ stateRoot: root });
        const identity = makeIdentity(root, "probe");
        const id = yield* deriveStackId(identity);
        yield* store.initialize(id, baseState(id, identity));
        const checkHostPort = (address: string, port: number, field: string) =>
          port === 40000 || port === 30000
            ? Effect.fail(new PortUnavailableError({ address, port, field, message: "occupied" }))
            : Effect.void;
        const coordinator = makePortCoordinator({
          stateRoot: root,
          store,
          checkHostPort,
          bindHost: makeTestHostListener,
        });
        const reservation = yield* coordinator.planAndReserve(id, intents("automatic"), {
          privateBindings: [{ workloadId: "db", binding: "postgres" }],
        });
        expect(reservation.assignments.api?.port).toBe(40001);
        expect(reservation.privateAssignments[0]?.port).toBe(30001);
      }),
    ),
  );

  it.live("reports public probe-budget exhaustion distinctly", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "supabase-stack-port-probe-limit-",
        });
        const store = yield* makeStackStateStore({ stateRoot: root });
        const identity = makeIdentity(root, "public-probe-limit");
        const id = yield* deriveStackId(identity);
        yield* store.initialize(id, baseState(id, identity));
        const checkHostPort = (address: string, port: number, field: string) =>
          Effect.fail(new PortUnavailableError({ address, port, field, message: "occupied" }));
        const coordinator = makePortCoordinator({
          stateRoot: root,
          store,
          checkHostPort,
          bindHost: makeTestHostListener,
        });
        const result = yield* coordinator
          .planAndReserve(id, {
            ...disabledIntents(),
            api: { enabled: true, address: "127.0.0.1", port: "automatic" },
          })
          .pipe(Effect.exit);
        const error = errorOf(result);
        expect(error).toBeInstanceOf(PortAllocationError);
        expect(error?.message).toContain("public");
        expect(error?.message).toContain("16");
      }),
    ),
  );

  it.live("reports private probe-budget exhaustion distinctly", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "supabase-stack-private-probe-limit-",
        });
        const store = yield* makeStackStateStore({ stateRoot: root });
        const identity = makeIdentity(root, "private-probe-limit");
        const id = yield* deriveStackId(identity);
        yield* store.initialize(id, baseState(id, identity));
        const checkHostPort = (address: string, port: number, field: string) =>
          Effect.fail(new PortUnavailableError({ address, port, field, message: "occupied" }));
        const coordinator = makePortCoordinator({
          stateRoot: root,
          store,
          checkHostPort,
          bindHost: makeTestHostListener,
        });
        const result = yield* coordinator
          .planAndReserve(id, disabledIntents(), {
            privateBindings: [{ workloadId: "db", binding: "postgres" }],
          })
          .pipe(Effect.exit);
        const error = errorOf(result);
        expect(error).toBeInstanceOf(PortAllocationError);
        expect(error?.message).toContain("private");
        expect(error?.message).toContain("16");
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
        yield* store.initialize(a, baseState(a, aIdentity));
        yield* store.initialize(b, baseState(b, bIdentity));
        const coordinator = makePortCoordinator({
          stateRoot: root,
          store,
          checkHostPort: successfulHostPortCheck,
          bindHost: makeTestHostListener,
        });
        const automatic = yield* coordinator.planAndReserve(a, intents("automatic"));
        const occupied = automatic.assignments.api?.port;
        expect(occupied).toBeTypeOf("number");
        if (occupied === undefined) return;
        const exit = yield* coordinator
          .planAndReserve(b, {
            ...disabledIntents(),
            api: { enabled: true, address: "127.0.0.1", port: occupied },
          })
          .pipe(Effect.exit);
        expect(errorOf(exit)).toBeInstanceOf(PortAllocationError);
        expect((yield* store.read(b))?.ports).toEqual([]);
      }),
    ),
  );

  it.live("applies listener changes already accepted by the lifecycle", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-stack-port-running-" });
        const store = yield* makeStackStateStore({ stateRoot: root });
        const exactIdentity = makeIdentity(root, "running-exact");
        const automaticIdentity = makeIdentity(root, "running-automatic");
        const exactId = yield* deriveStackId(exactIdentity);
        const automaticId = yield* deriveStackId(automaticIdentity);
        yield* store.initialize(exactId, {
          ...baseState(exactId, exactIdentity, "running"),
          ports: [{ field: "api", port: 55435, intent: "exact" }],
          privatePorts: [],
        });
        yield* store.initialize(automaticId, {
          ...baseState(automaticId, automaticIdentity, "running"),
          ports: [{ field: "api", port: 55436, intent: "automatic" }],
          privatePorts: [],
        });
        const coordinator = makePortCoordinator({
          stateRoot: root,
          store,
          checkHostPort: successfulHostPortCheck,
          bindHost: makeTestHostListener,
        });
        const exactToDifferent = yield* coordinator.planAndReserve(exactId, {
          ...disabledIntents(),
          api: { enabled: true, address: "127.0.0.1", port: 55437 },
        });
        expect(exactToDifferent.assignments.api?.port).toBe(55437);

        const automaticToExact = yield* coordinator.planAndReserve(automaticId, {
          ...disabledIntents(),
          api: { enabled: true, address: "127.0.0.1", port: 55438 },
        });
        expect(automaticToExact.assignments.api?.port).toBe(55438);
      }),
    ),
  );

  it.live("keeps an unchanged running assignment", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "supabase-stack-port-running-repeat-",
        });
        const store = yield* makeStackStateStore({ stateRoot: root });
        const identity = makeIdentity(root, "running-repeat");
        const stackId = yield* deriveStackId(identity);
        yield* store.initialize(stackId, {
          ...baseState(stackId, identity, "running"),
          ports: [{ field: "api", port: 55439, intent: "exact" }],
          privatePorts: [],
        });
        const coordinator = makePortCoordinator({
          stateRoot: root,
          store,
          checkHostPort: successfulHostPortCheck,
          bindHost: makeTestHostListener,
        });
        const result = yield* coordinator.planAndReserve(stackId, {
          ...disabledIntents(),
          api: { enabled: true, address: "127.0.0.1", port: 55439 },
        });
        expect(result.assignments.api?.port).toBe(55439);
      }),
    ),
  );

  it.live("materializes ports for a newly accepted running stack", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "supabase-stack-port-running-initial-",
        });
        const store = yield* makeStackStateStore({ stateRoot: root });
        const identity = makeIdentity(root, "running-initial");
        const stackId = yield* deriveStackId(identity);
        yield* store.initialize(stackId, {
          ...baseState(stackId, identity, "running"),
          ports: [
            { field: "api", port: 55440, intent: "exact" },
            { field: "database", port: 55441, intent: "automatic" },
          ],
          privatePorts: [],
        });
        const coordinator = makePortCoordinator({
          stateRoot: root,
          store,
          checkHostPort: successfulHostPortCheck,
          bindHost: makeTestHostListener,
        });
        const result = yield* coordinator.planAndReserve(
          stackId,
          {
            ...disabledIntents(),
            api: { enabled: true, address: "127.0.0.1", port: 55440 },
            database: { enabled: true, address: "127.0.0.1", port: "automatic" },
          },
          {},
        );
        expect(result.assignments.api?.port).toBe(55440);
        expect((yield* store.read(stackId))?.desiredLifecycle).toBe("running");
      }),
    ),
  );

  it.live("materializes a newly accepted running stack with no listeners", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "supabase-stack-port-running-empty-",
        });
        const store = yield* makeStackStateStore({ stateRoot: root });
        const identity = makeIdentity(root, "running-empty");
        const stackId = yield* deriveStackId(identity);
        yield* store.initialize(stackId, {
          ...baseState(stackId, identity, "running"),
        });
        const coordinator = makePortCoordinator({
          stateRoot: root,
          store,
          checkHostPort: successfulHostPortCheck,
          bindHost: makeTestHostListener,
        });
        const result = yield* coordinator.planAndReserve(stackId, disabledIntents(), {});
        expect(result.hostListeners).toHaveLength(0);
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
        yield* store.initialize(c, {
          ...baseState(c, cIdentity, "running"),
          ports: [{ field: "api", port: 55432, intent: "exact" }],
          privatePorts: [],
        });
        yield* store.initialize(d, baseState(d, dIdentity));
        const coordinator = makePortCoordinator({
          stateRoot: root,
          store,
          checkHostPort: successfulHostPortCheck,
          bindHost: makeTestHostListener,
        });
        yield* coordinator.planAndReserve(d, intents(55432));
        const stopped = yield* store.read(d);
        if (stopped === undefined) return;
        yield* store.replace(d, { ...stopped, desiredLifecycle: "running" });
        const conflict = yield* coordinator.planAndReserve(d, intents(55432)).pipe(Effect.exit);
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
        yield* store.initialize(stackId, baseState(stackId, identity));
        const coordinator = makePortCoordinator({
          stateRoot: root,
          store,
          checkHostPort: successfulHostPortCheck,
          bindHost: makeTestHostListener,
        });
        const exit = yield* coordinator
          .planAndReserve(stackId, {
            ...disabledIntents(),
            api: { enabled: true, address: "127.0.0.1", port: 55434 },
            database: { enabled: true, address: "127.0.0.1", port: 55434 },
          })
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
        yield* store.initialize(stackId, baseState(stackId, identity));
        const host = yield* holdHostPort(0);
        const hostAddress = host.address();
        expect(hostAddress).toBeTypeOf("object");
        if (typeof hostAddress !== "object" || hostAddress === null) return;
        const occupiedPort = hostAddress.port;
        const running = {
          ...baseState(stackId, identity, "running"),
          ports: [{ field: "api", port: occupiedPort, intent: "exact" as const }] as const,
        };
        yield* store.replace(stackId, running);
        const coordinator = makePortCoordinator({
          stateRoot: root,
          store,
          checkHostPort: successfulHostPortCheck,
          bindHost: bindHostListener,
        });
        const exit = yield* coordinator
          .planAndReserve(stackId, {
            ...disabledIntents(),
            api: { enabled: true, address: "127.0.0.1", port: occupiedPort },
          })
          .pipe(Effect.exit);
        expect(errorOf(exit)).toBeInstanceOf(PortUnavailableError);
        expect(
          ((yield* store.read(stackId))?.ports ?? []).some(
            (assignment) => assignment.port === occupiedPort,
          ),
        ).toBe(true);
      }),
    ),
  );

  it.live("retains coordinated listener ownership through the enclosing scope", () =>
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
          yield* store.initialize(e, {
            ...baseState(e, eIdentity, "running"),
            ports: [
              { field: "api", port: 55450, intent: "automatic" },
              { field: "database", port: 55451, intent: "automatic" },
            ],
          });
          const coordinator = makePortCoordinator({
            stateRoot: root,
            store,
            checkHostPort: successfulHostPortCheck,
            bindHost: (address, port, field) =>
              bound.has(port)
                ? Effect.fail(new PortUnavailableError({ port, field, message: "already bound" }))
                : makeTestHostListener(address, port, field, {
                    onClose: () => {
                      bound.delete(port);
                      closed += 1;
                    },
                  }).pipe(Effect.tap(() => Effect.sync(() => bound.add(port)))),
          });
          const result = yield* coordinator.planAndReserve(e, intents("automatic"), {});
          expect(result.hostListeners).toHaveLength(2);
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
        yield* store.initialize(stackId, {
          ...baseState(stackId, identity, "running"),
          ports: [
            { field: "api", port: 55452, intent: "automatic" },
            { field: "database", port: 55453, intent: "automatic" },
          ],
        });
        const bound = new Set<number>();
        let attempts = 0;
        const coordinator = makePortCoordinator({
          stateRoot: root,
          store,
          checkHostPort: successfulHostPortCheck,
          bindHost: (address, port, field) => {
            attempts += 1;
            if (attempts === 2)
              return Effect.fail(
                new PortUnavailableError({ port, field, message: "simulated second bind failure" }),
              );
            return makeTestHostListener(address, port, field, {
              onClose: () => bound.delete(port),
            }).pipe(Effect.tap(() => Effect.sync(() => bound.add(port))));
          },
        });
        const exit = yield* coordinator
          .planAndReserve(stackId, intents("automatic"), {})
          .pipe(Effect.exit);
        expect(errorOf(exit)).toBeInstanceOf(PortUnavailableError);
        expect(bound).toHaveLength(0);
        const retry = yield* coordinator.planAndReserve(stackId, intents("automatic"), {});
        expect(retry.hostListeners).toHaveLength(2);
      }),
    ),
  );

  it.live("retries a fresh automatic bind failure with the next candidate", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "supabase-stack-port-bind-retry-",
        });
        const store = yield* makeStackStateStore({ stateRoot: root });
        const identity = makeIdentity(root, "bind-retry");
        const stackId = yield* deriveStackId(identity);
        yield* store.initialize(stackId, baseState(stackId, identity, "running"));
        const attempts: number[] = [];
        const coordinator = makePortCoordinator({
          stateRoot: root,
          store,
          checkHostPort: successfulHostPortCheck,
          bindHost: (address, port, field) => {
            attempts.push(port);
            return port === 40_000
              ? Effect.fail(
                  new PortUnavailableError({ port, field, message: "simulated bind race" }),
                )
              : makeTestHostListener(address, port, field);
          },
        });
        const reservation = yield* coordinator.planAndReserve(stackId, {
          ...disabledIntents(),
          api: { enabled: true, address: "127.0.0.1", port: "automatic" },
        });
        expect(attempts).toEqual([40_000, 40_001]);
        expect(reservation.assignments.api?.port).toBe(40_001);
        expect((yield* store.read(stackId))?.ports).toEqual([
          { field: "api", port: 40_001, intent: "automatic" },
        ]);
      }),
    ),
  );

  it.live("keeps exact and sticky automatic assignments after bind failure", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "supabase-stack-port-bind-sticky-",
        });
        const store = yield* makeStackStateStore({ stateRoot: root });
        const exactIdentity = makeIdentity(root, "bind-exact");
        const stickyIdentity = makeIdentity(root, "bind-sticky");
        const exactId = yield* deriveStackId(exactIdentity);
        const stickyId = yield* deriveStackId(stickyIdentity);
        yield* store.initialize(exactId, baseState(exactId, exactIdentity, "running"));
        yield* store.initialize(stickyId, {
          ...baseState(stickyId, stickyIdentity, "running"),
          ports: [{ field: "api", port: 45_500, intent: "automatic" }],
        });
        const coordinator = makePortCoordinator({
          stateRoot: root,
          store,
          checkHostPort: successfulHostPortCheck,
          bindHost: (_address, port, field) =>
            Effect.fail(new PortUnavailableError({ port, field, message: "simulated bind race" })),
        });
        const exact = yield* coordinator
          .planAndReserve(exactId, {
            ...disabledIntents(),
            api: { enabled: true, address: "127.0.0.1", port: 45_501 },
          })
          .pipe(Effect.exit);
        expect(errorOf(exact)).toBeInstanceOf(PortUnavailableError);
        expect((yield* store.read(exactId))?.ports).toEqual([
          { field: "api", port: 45_501, intent: "exact" },
        ]);
        const sticky = yield* coordinator
          .planAndReserve(stickyId, {
            ...disabledIntents(),
            api: { enabled: true, address: "127.0.0.1", port: "automatic" },
          })
          .pipe(Effect.exit);
        expect(errorOf(sticky)).toBeInstanceOf(PortUnavailableError);
        expect((yield* store.read(stickyId))?.ports).toEqual([
          { field: "api", port: 45_500, intent: "automatic" },
        ]);
      }),
    ),
  );

  it.live("closes listeners acquired before a fresh bind retry", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "supabase-stack-port-bind-retry-close-",
        });
        const store = yield* makeStackStateStore({ stateRoot: root });
        const identity = makeIdentity(root, "bind-retry-close");
        const stackId = yield* deriveStackId(identity);
        yield* store.initialize(stackId, baseState(stackId, identity, "running"));
        const bound = new Set<number>();
        const closeEvents: number[] = [];
        let failed = false;
        const coordinator = makePortCoordinator({
          stateRoot: root,
          store,
          checkHostPort: successfulHostPortCheck,
          bindHost: (address, port, field) => {
            if (port === 40_001 && !failed) {
              failed = true;
              return Effect.fail(
                new PortUnavailableError({ port, field, message: "simulated bind race" }),
              );
            }
            return makeTestHostListener(address, port, field, {
              onClose: () => {
                bound.delete(port);
                closeEvents.push(port);
              },
            }).pipe(Effect.tap(() => Effect.sync(() => bound.add(port))));
          },
        });
        const reservation = yield* coordinator.planAndReserve(stackId, intents("automatic"));
        expect(reservation.hostListeners).toHaveLength(2);
        expect(bound.size).toBe(2);
        expect(closeEvents).toEqual([40_000]);
        expect(reservation.assignments.api?.port).toBe(40_000);
        expect(reservation.assignments.database?.port).toBe(40_002);
      }),
    ),
  );

  it.live("bounds fresh automatic bind retries and rolls back the reservation", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "supabase-stack-port-bind-limit-",
        });
        const store = yield* makeStackStateStore({ stateRoot: root });
        const identity = makeIdentity(root, "bind-limit");
        const stackId = yield* deriveStackId(identity);
        yield* store.initialize(stackId, baseState(stackId, identity, "running"));
        const attempts: number[] = [];
        const coordinator = makePortCoordinator({
          stateRoot: root,
          store,
          checkHostPort: successfulHostPortCheck,
          bindHost: (_address, port, field) => {
            attempts.push(port);
            return Effect.fail(
              new PortUnavailableError({ port, field, message: "always occupied" }),
            );
          },
        });
        const result = yield* coordinator
          .planAndReserve(stackId, {
            ...disabledIntents(),
            api: { enabled: true, address: "127.0.0.1", port: "automatic" },
          })
          .pipe(Effect.exit);
        expect(errorOf(result)).toBeInstanceOf(PortUnavailableError);
        expect(attempts).toHaveLength(17);
        expect(attempts.at(-1)).toBe(40_016);
        expect((yield* store.read(stackId))?.ports).toEqual([]);
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
        yield* store.initialize(f, {
          ...baseState(f, fIdentity, "running"),
          ports: [
            { field: "api", port: 55433, intent: "exact" },
            { field: "database", port: 55434, intent: "automatic" },
          ],
        });
        const coordinator = makePortCoordinator({
          stateRoot: root,
          store,
          checkHostPort: successfulHostPortCheck,
          bindHost: (address, port, field) =>
            Effect.fail(new PortUnavailableError({ port, field, message: `race at ${address}` })),
        });
        const exit = yield* coordinator.planAndReserve(f, intents(55433), {}).pipe(Effect.exit);
        expect(errorOf(exit)).toBeInstanceOf(PortUnavailableError);
        const reserved = (yield* store.read(f))?.ports ?? [];
        expect(reserved.some((assignment) => assignment.port === 55433)).toBe(true);
      }),
    ),
  );

  it.live("allocates distinct durable private bindings and retains them across stop", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-stack-private-" });
        const store = yield* makeStackStateStore({ stateRoot: root });
        const identity = makeIdentity(root, "private");
        const stackId = yield* deriveStackId(identity);
        yield* store.initialize(stackId, baseState(stackId, identity));
        const coordinator = makePortCoordinator({
          stateRoot: root,
          store,
          checkHostPort: successfulHostPortCheck,
          bindHost: makeTestHostListener,
        });
        const bindings = [
          { workloadId: "mail:mail", binding: "ui" },
          { workloadId: "mail:mail", binding: "smtp" },
          { workloadId: "mail:mail", binding: "pop3" },
          { workloadId: "database:database", binding: "primary" },
        ];
        const first = yield* coordinator.planAndReserve(stackId, disabledIntents(), {
          privateBindings: bindings,
        });
        expect(first.privateAssignments).toHaveLength(bindings.length);
        expect(new Set(first.privateAssignments.map((entry) => entry.port)).size).toBe(
          bindings.length,
        );
        expect(first.privateAssignments.every((entry) => entry.port >= 30_000)).toBe(true);
        const stopped = yield* coordinator.planAndReserve(stackId, disabledIntents(), {
          privateBindings: bindings,
        });
        expect(stopped.privateAssignments).toEqual(first.privateAssignments);
      }),
    ),
  );

  it.live("keeps private ports exclusive across stacks and rejects public overlap", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "supabase-stack-private-conflict-",
        });
        const store = yield* makeStackStateStore({ stateRoot: root });
        const aIdentity = makeIdentity(root, "private-a");
        const bIdentity = makeIdentity(root, "private-b");
        const a = yield* deriveStackId(aIdentity);
        const b = yield* deriveStackId(bIdentity);
        yield* store.initialize(a, baseState(a, aIdentity));
        yield* store.initialize(b, baseState(b, bIdentity));
        const coordinator = makePortCoordinator({
          stateRoot: root,
          store,
          checkHostPort: successfulHostPortCheck,
          bindHost: makeTestHostListener,
        });
        const first = yield* coordinator.planAndReserve(a, disabledIntents(), {
          privateBindings: [{ workloadId: "database:database", binding: "primary" }],
        });
        const second = yield* coordinator.planAndReserve(b, disabledIntents(), {
          privateBindings: [{ workloadId: "database:database", binding: "primary" }],
        });
        expect(second.privateAssignments[0]?.port).not.toBe(first.privateAssignments[0]?.port);
        const overlapping = yield* store
          .replace(a, {
            ...baseState(a, aIdentity),
            ports: [{ field: "api", port: 30_000, intent: "exact" }],
            privatePorts: [{ workloadId: "database:database", binding: "primary", port: 30_000 }],
          })
          .pipe(Effect.exit);
        expect(errorOf(overlapping)).toBeDefined();
      }),
    ),
  );
});
