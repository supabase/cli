import { NodeServices, NodeSocketServer } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Cause, Context, Effect, Exit, FileSystem, Layer, Option, Ref, Scope } from "effect";
import { makePorts, PortError } from "./Ports.ts";
import * as State from "./State.ts";

const makeTestState = (root: string) =>
  Layer.build(State.layer({ root })).pipe(
    Effect.map((context) => Context.get(context, State.Service)),
  );

const bind = (host: string, port: number) =>
  NodeSocketServer.make({ host, port }).pipe(
    Effect.mapError((cause) => new PortError({ key: "sql", message: "Cannot bind", cause })),
  );

it.live("retains distinct claims for stopped stacks and rebinds the original public port", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const state = yield* makeTestState(root);
      for (const id of ["first", "second"])
        yield* state.save({
          id,
          runtime: "native",
          identity: { projectRoot: root, branchContext: "test", stackName: "ports" },
          instances: [],
          lifetime: "detached",
          composition: { members: [], dependencies: [] },
          ports: [],
        });
      const ports = yield* makePorts(state);
      const firstScope = yield* Scope.make();
      const request = { stackId: "first", key: "db/sql", host: "127.0.0.1", port: "auto" as const };
      const first = yield* ports
        .acquire(request, bind)
        .pipe(Effect.provideService(Scope.Scope, firstScope));
      yield* Scope.close(firstScope, Exit.void);
      const second = yield* ports.acquire({ ...request, stackId: "second" }, bind);
      expect(second.port).not.toBe(first.port);
      const reopened = yield* makePorts(yield* makeTestState(root));
      const again = yield* reopened.acquire(request, bind);
      expect(again.port).toBe(first.port);
      expect((yield* state.read("first"))?.ports).toEqual([
        { key: "db/sql", host: "127.0.0.1", port: first.port },
      ]);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("reports an occupied saved port without moving its assignment", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const state = yield* makeTestState(root);
      yield* state.save({
        id: "stack",
        runtime: "native",
        identity: { projectRoot: root, branchContext: "test", stackName: "ports" },
        instances: [],
        lifetime: "detached",
        composition: { members: [], dependencies: [] },
        ports: [],
      });
      const ports = yield* makePorts(state);
      const scope = yield* Scope.make();
      const request = { stackId: "stack", key: "api", host: "127.0.0.1", port: "auto" as const };
      const first = yield* ports
        .acquire(request, bind)
        .pipe(Effect.provideService(Scope.Scope, scope));
      yield* Scope.close(scope, Exit.void);
      yield* bind("127.0.0.1", first.port);
      const failure = yield* ports.acquire(request, bind).pipe(Effect.flip);
      expect(failure).toBeInstanceOf(PortError);
      expect(failure.message).toContain(`api at 127.0.0.1:${first.port}`);
      expect(failure.message).not.toContain("claims this port");
      expect((yield* state.read("stack"))?.ports[0]?.port).toBe(first.port);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("allocates an auto port outside a contiguous range that refuses to bind", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const state = yield* makeTestState(root);
      yield* state.save({
        id: "stack",
        runtime: "native",
        identity: { projectRoot: root, branchContext: "test", stackName: "ports" },
        instances: [],
        lifetime: "detached",
        composition: { members: [], dependencies: [] },
        ports: [],
      });
      const ports = yield* makePorts(state);
      // Reserves most of the span contiguously, as Windows excluded ranges do.
      const reservedBelow = 30000;
      const acquired = yield* ports.acquire(
        { stackId: "stack", key: "api", host: "127.0.0.1", port: "auto" },
        (host, port) =>
          port < reservedBelow
            ? Effect.fail(new PortError({ key: "api", message: `bind EACCES ${host}:${port}` }))
            : Effect.succeed(port),
      );
      expect(acquired.port).toBeGreaterThanOrEqual(reservedBelow);
      expect((yield* state.read("stack"))?.ports).toEqual([
        { key: "api", host: "127.0.0.1", port: acquired.port },
      ]);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("reassigns the same auto port after its claim is released", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const state = yield* makeTestState(root);
      yield* state.save({
        id: "stack",
        runtime: "native",
        identity: { projectRoot: root, branchContext: "test", stackName: "ports" },
        instances: [],
        lifetime: "detached",
        composition: { members: [], dependencies: [] },
        ports: [],
      });
      const ports = yield* makePorts(state);
      const request = { stackId: "stack", key: "api", host: "127.0.0.1", port: "auto" as const };
      const accept = (_host: string, port: number) => Effect.succeed(port);
      const first = yield* ports.acquire(request, accept);
      yield* ports.release("stack", "api");
      const again = yield* ports.acquire(request, accept);
      expect(again.port).toBe(first.port);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("names the last bind failure when no public port is available", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const state = yield* makeTestState(root);
      yield* state.save({
        id: "stack",
        runtime: "native",
        identity: { projectRoot: root, branchContext: "test", stackName: "ports" },
        instances: [],
        lifetime: "detached",
        composition: { members: [], dependencies: [] },
        ports: [],
      });
      const ports = yield* makePorts(state);
      const failure = yield* ports
        .acquire({ stackId: "stack", key: "api", host: "127.0.0.1", port: "auto" }, (host, port) =>
          Effect.fail(new PortError({ key: "api", message: `bind EACCES ${host}:${port}` })),
        )
        .pipe(Effect.flip);
      expect(failure.message).toContain("No public port is available");
      expect(failure.message).toContain("bind EACCES 127.0.0.1:");
      expect((yield* state.read("stack"))?.ports).toEqual([]);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

const saveStack = (
  state: State.Interface,
  root: string,
  id: string,
  ports: State.SavedStack["ports"] = [],
) =>
  state.save({
    id,
    runtime: "native",
    identity: { projectRoot: root, branchContext: `branch-${id}`, stackName: id },
    instances: [],
    lifetime: "detached",
    composition: { members: [], dependencies: [] },
    ports,
  });

it.live("allocates past siblings whose state is unreadable or from a newer format", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const state = yield* makeTestState(root);
      yield* saveStack(state, root, "healthy");
      yield* fs.makeDirectory(`${root}/broken`);
      yield* fs.writeFileString(`${root}/broken/state.json`, "{broken");
      yield* fs.makeDirectory(`${root}/newer`);
      yield* fs.writeFileString(
        `${root}/newer/state.json`,
        '{"id":"newer","runtime":"future","ports":[]}',
      );
      const ports = yield* makePorts(state);
      const acquired = yield* ports.acquire(
        { stackId: "healthy", key: "sql", host: "127.0.0.1", port: "auto" },
        bind,
      );
      expect((yield* state.read("healthy"))?.ports).toEqual([
        { key: "sql", host: "127.0.0.1", port: acquired.port },
      ]);
      expect(yield* fs.readFileString(`${root}/broken/state.json`)).toBe("{broken");
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("keeps auto allocation off ports claimed by a sibling in a newer format", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const state = yield* makeTestState(root);
      yield* saveStack(state, root, "stack");
      const ports = yield* makePorts(state);
      const request = { stackId: "stack", key: "api", host: "127.0.0.1", port: "auto" as const };
      const accept = (_host: string, port: number) => Effect.succeed(port);
      const preferred = yield* ports.acquire(request, accept);
      yield* ports.release("stack", "api");
      yield* fs.makeDirectory(`${root}/newer`);
      yield* fs.writeFileString(
        `${root}/newer/state.json`,
        `{"id":"newer","runtime":"future","ports":[{"key":"api","host":"127.0.0.1","port":${preferred.port}}]}`,
      );
      const moved = yield* ports.acquire(request, accept);
      expect(moved.port).not.toBe(preferred.port);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("lets a stack bind an explicit port that a stopped stack still claims", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const state = yield* makeTestState(root);
      yield* saveStack(state, root, "stopped");
      yield* saveStack(state, root, "current");
      const ports = yield* makePorts(state);
      const stoppedScope = yield* Scope.make();
      const stopped = yield* ports
        .acquire({ stackId: "stopped", key: "db/sql", host: "127.0.0.1", port: "auto" }, bind)
        .pipe(Effect.provideService(Scope.Scope, stoppedScope));
      yield* Scope.close(stoppedScope, Exit.void);

      const current = yield* ports.acquire(
        { stackId: "current", key: "db/sql", host: "127.0.0.1", port: stopped.port },
        bind,
      );
      expect(current.port).toBe(stopped.port);
      expect((yield* state.read("stopped"))?.ports).toEqual([
        { key: "db/sql", host: "127.0.0.1", port: stopped.port },
      ]);
      expect((yield* state.read("current"))?.ports).toEqual([
        { key: "db/sql", host: "127.0.0.1", port: stopped.port },
      ]);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("names the stack claiming an explicit port that a live listener holds", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const state = yield* makeTestState(root);
      yield* saveStack(state, root, "holder");
      yield* saveStack(state, root, "current");
      const ports = yield* makePorts(state);
      const held = yield* ports.acquire(
        { stackId: "holder", key: "db/sql", host: "127.0.0.1", port: "auto" },
        bind,
      );

      const failure = yield* ports
        .acquire({ stackId: "current", key: "db/sql", host: "127.0.0.1", port: held.port }, bind)
        .pipe(Effect.flip);
      expect(failure).toBeInstanceOf(PortError);
      expect(failure.message).toContain(`db/sql at 127.0.0.1:${held.port}`);
      expect(failure.message).toContain(`stack "holder" on branch-holder in ${root}`);
      expect((yield* state.read("current"))?.ports).toEqual([]);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

for (const [held, requested] of [
  ["127.0.0.1", "0.0.0.0"],
  ["::1", "127.0.0.1"],
] as const)
  it.live(`rejects ${requested} on a port a ${held} listener holds where binds can overlap`, () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped();
        const state = yield* makeTestState(root);
        yield* saveStack(state, root, "holder");
        yield* saveStack(state, root, "current");
        const ports = yield* makePorts(state, "darwin");
        const listener = yield* ports.acquire(
          { stackId: "holder", key: "api", host: held, port: "auto" },
          bind,
        );
        const overlappingBinds = yield* Ref.make(0);

        const failure = yield* ports
          .acquire({ stackId: "current", key: "api", host: requested, port: listener.port }, () =>
            Ref.update(overlappingBinds, (count) => count + 1),
          )
          .pipe(Effect.flip);
        expect(failure.message).toContain("already in use");
        expect(failure.message).toContain(`stack "holder"`);
        expect(yield* Ref.get(overlappingBinds)).toBe(0);
        expect((yield* state.read("current"))?.ports).toEqual([]);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

it.live("leaves a fixed port to the bind where overlapping binds are rejected", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const state = yield* makeTestState(root);
      yield* saveStack(state, root, "holder");
      yield* saveStack(state, root, "current");
      const ports = yield* makePorts(state, "linux");
      const listener = yield* ports.acquire(
        { stackId: "holder", key: "api", host: "127.0.0.1", port: "auto" },
        bind,
      );
      const binds = yield* Ref.make(0);

      const acquired = yield* ports.acquire(
        { stackId: "current", key: "api", host: "0.0.0.0", port: listener.port },
        () => Ref.update(binds, (count) => count + 1),
      );
      expect(acquired.port).toBe(listener.port);
      expect(yield* Ref.get(binds)).toBe(1);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("lets a stack bind a port that a running stack claims but does not listen on", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const state = yield* makeTestState(root);
      yield* saveStack(state, root, "running");
      yield* saveStack(state, root, "current");
      const ports = yield* makePorts(state);
      yield* ports.acquire(
        { stackId: "running", key: "admin", host: "127.0.0.1", port: "auto" },
        bind,
      );
      const restScope = yield* Scope.make();
      const rest = yield* ports
        .acquire({ stackId: "running", key: "api", host: "127.0.0.1", port: "auto" }, bind)
        .pipe(Effect.provideService(Scope.Scope, restScope));
      yield* Scope.close(restScope, Exit.void);

      const current = yield* ports.acquire(
        { stackId: "current", key: "api", host: "127.0.0.1", port: rest.port },
        bind,
      );
      expect(current.port).toBe(rest.port);
      expect((yield* state.read("current"))?.ports).toEqual([
        { key: "api", host: "127.0.0.1", port: rest.port },
      ]);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("lets exactly one of two stacks sharing a saved port bind it when both start at once", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const state = yield* makeTestState(root);
      yield* saveStack(state, root, "first");
      const ports = yield* makePorts(state);
      const request = { stackId: "first", key: "api", host: "127.0.0.1", port: "auto" as const };
      const seedScope = yield* Scope.make();
      const seed = yield* ports
        .acquire(request, bind)
        .pipe(Effect.provideService(Scope.Scope, seedScope));
      yield* Scope.close(seedScope, Exit.void);
      yield* saveStack(state, root, "second", [{ key: "api", host: "127.0.0.1", port: seed.port }]);

      const [first, second] = yield* Effect.all(
        [
          Effect.exit(ports.acquire(request, bind)),
          Effect.exit(ports.acquire({ ...request, stackId: "second" }, bind)),
        ],
        { concurrency: "unbounded" },
      );
      const outcomes = [
        { claimant: "second", exit: first },
        { claimant: "first", exit: second },
      ];
      expect(outcomes.filter(({ exit }) => Exit.isSuccess(exit))).toHaveLength(1);
      const loser = outcomes.find(({ exit }) => Exit.isFailure(exit));
      const failure =
        loser !== undefined && Exit.isFailure(loser.exit)
          ? Cause.findErrorOption(loser.exit.cause)
          : Option.none();
      if (Option.isNone(failure)) return yield* Effect.die("expected a port conflict");
      expect(failure.value).toBeInstanceOf(PortError);
      expect(failure.value.message).toContain(`127.0.0.1:${seed.port}`);
      expect(failure.value.message).toContain(`stack "${loser?.claimant}"`);
      for (const id of ["first", "second"])
        expect((yield* state.read(id))?.ports).toEqual([
          { key: "api", host: "127.0.0.1", port: seed.port },
        ]);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
