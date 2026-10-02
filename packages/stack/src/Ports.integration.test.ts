import { NodeServices, NodeSocketServer } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Cause, Context, Effect, Exit, FileSystem, Hash, Layer, Option, Ref, Scope } from "effect";
import { makePorts, portBase, portSpan, PortError, reserveNativePort } from "./Ports.ts";
import * as State from "./State.ts";
import {
  sharedPortClaims,
  sharedStateRoot,
  uniqueStackId,
} from "../tests/helpers/integration-state.ts";

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
      const root = sharedStateRoot();
      const state = yield* makeTestState(root);
      const firstId = uniqueStackId("first");
      const secondId = uniqueStackId("second");
      for (const id of [firstId, secondId])
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
      const request = {
        stackId: firstId,
        key: "db/sql",
        host: "127.0.0.1",
        port: "auto" as const,
      };
      const first = yield* ports
        .acquire(request, bind)
        .pipe(Effect.provideService(Scope.Scope, firstScope));
      yield* Scope.close(firstScope, Exit.void);
      const second = yield* ports.acquire({ ...request, stackId: secondId }, bind);
      expect(second.port).not.toBe(first.port);
      const reopened = yield* makePorts(yield* makeTestState(root));
      const again = yield* reopened.acquire(request, bind);
      expect(again.port).toBe(first.port);
      expect((yield* state.read(firstId))?.ports).toEqual([
        { key: "db/sql", host: "127.0.0.1", port: first.port },
      ]);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("reports an occupied saved port without moving its assignment", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const root = sharedStateRoot();
      const state = yield* makeTestState(root);
      const stackId = uniqueStackId("stack");
      yield* state.save({
        id: stackId,
        runtime: "native",
        identity: { projectRoot: root, branchContext: "test", stackName: "ports" },
        instances: [],
        lifetime: "detached",
        composition: { members: [], dependencies: [] },
        ports: [],
      });
      const ports = yield* makePorts(state);
      const scope = yield* Scope.make();
      const request = { stackId, key: "api", host: "127.0.0.1", port: "auto" as const };
      const first = yield* ports
        .acquire(request, bind)
        .pipe(Effect.provideService(Scope.Scope, scope));
      yield* Scope.close(scope, Exit.void);
      yield* bind("127.0.0.1", first.port);
      const failure = yield* ports.acquire(request, bind).pipe(Effect.flip);
      expect(failure).toBeInstanceOf(PortError);
      expect(failure.message).toContain(`api at 127.0.0.1:${first.port}`);
      expect(failure.message).not.toContain("claims this port");
      expect((yield* state.read(stackId))?.ports[0]?.port).toBe(first.port);
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
      const ports = yield* makePorts(state, "linux");
      const accept = (_host: string, port: number) => Effect.succeed(port);
      const acquired = yield* ports.acquire(
        { stackId: "healthy", key: "sql", host: "127.0.0.1", port: "auto" },
        accept,
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
      const ports = yield* makePorts(state, "linux");
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
      const root = sharedStateRoot();
      const state = yield* makeTestState(root);
      const stoppedId = uniqueStackId("stopped");
      const currentId = uniqueStackId("current");
      yield* saveStack(state, root, stoppedId);
      yield* saveStack(state, root, currentId);
      const ports = yield* makePorts(state);
      const stoppedScope = yield* Scope.make();
      const stopped = yield* ports
        .acquire({ stackId: stoppedId, key: "db/sql", host: "127.0.0.1", port: "auto" }, bind)
        .pipe(Effect.provideService(Scope.Scope, stoppedScope));
      yield* Scope.close(stoppedScope, Exit.void);

      const current = yield* ports.acquire(
        { stackId: currentId, key: "db/sql", host: "127.0.0.1", port: stopped.port },
        bind,
      );
      expect(current.port).toBe(stopped.port);
      expect((yield* state.read(stoppedId))?.ports).toEqual([
        { key: "db/sql", host: "127.0.0.1", port: stopped.port },
      ]);
      expect((yield* state.read(currentId))?.ports).toEqual([
        { key: "db/sql", host: "127.0.0.1", port: stopped.port },
      ]);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("names the stack claiming an explicit port that a live listener holds", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const root = sharedStateRoot();
      const state = yield* makeTestState(root);
      const holderId = uniqueStackId("holder");
      const currentId = uniqueStackId("current");
      yield* saveStack(state, root, holderId);
      yield* saveStack(state, root, currentId);
      const ports = yield* makePorts(state);
      const held = yield* ports.acquire(
        { stackId: holderId, key: "db/sql", host: "127.0.0.1", port: "auto" },
        bind,
      );

      const failure = yield* ports
        .acquire({ stackId: currentId, key: "db/sql", host: "127.0.0.1", port: held.port }, bind)
        .pipe(Effect.flip);
      expect(failure).toBeInstanceOf(PortError);
      expect(failure.message).toContain(`db/sql at 127.0.0.1:${held.port}`);
      expect(failure.message).toContain(`stack "${holderId}" on branch-${holderId} in ${root}`);
      expect((yield* state.read(currentId))?.ports).toEqual([]);
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
        const root = sharedStateRoot();
        const state = yield* makeTestState(root);
        const holderId = uniqueStackId("holder");
        const currentId = uniqueStackId("current");
        yield* saveStack(state, root, holderId);
        yield* saveStack(state, root, currentId);
        const ports = yield* makePorts(state, "darwin");
        const listener = yield* ports.acquire(
          { stackId: holderId, key: "api", host: held, port: "auto" },
          bind,
        );
        const overlappingBinds = yield* Ref.make(0);

        const failure = yield* ports
          .acquire({ stackId: currentId, key: "api", host: requested, port: listener.port }, () =>
            Ref.update(overlappingBinds, (count) => count + 1),
          )
          .pipe(Effect.flip);
        expect(failure.message).toContain("already in use");
        expect(failure.message).toContain(`stack "${holderId}"`);
        expect(yield* Ref.get(overlappingBinds)).toBe(0);
        expect((yield* state.read(currentId))?.ports).toEqual([]);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

it.live("leaves a fixed port to the bind where overlapping binds are rejected", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const root = sharedStateRoot();
      const state = yield* makeTestState(root);
      const holderId = uniqueStackId("holder");
      const currentId = uniqueStackId("current");
      yield* saveStack(state, root, holderId);
      yield* saveStack(state, root, currentId);
      const ports = yield* makePorts(state, "linux");
      const listener = yield* ports.acquire(
        { stackId: holderId, key: "api", host: "127.0.0.1", port: "auto" },
        bind,
      );
      const binds = yield* Ref.make(0);

      const acquired = yield* ports.acquire(
        { stackId: currentId, key: "api", host: "0.0.0.0", port: listener.port },
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
      const root = sharedStateRoot();
      const state = yield* makeTestState(root);
      const runningId = uniqueStackId("running");
      const currentId = uniqueStackId("current");
      yield* saveStack(state, root, runningId);
      yield* saveStack(state, root, currentId);
      const ports = yield* makePorts(state);
      yield* ports.acquire(
        { stackId: runningId, key: "admin", host: "127.0.0.1", port: "auto" },
        bind,
      );
      const restScope = yield* Scope.make();
      const rest = yield* ports
        .acquire({ stackId: runningId, key: "api", host: "127.0.0.1", port: "auto" }, bind)
        .pipe(Effect.provideService(Scope.Scope, restScope));
      yield* Scope.close(restScope, Exit.void);

      const current = yield* ports.acquire(
        { stackId: currentId, key: "api", host: "127.0.0.1", port: rest.port },
        bind,
      );
      expect(current.port).toBe(rest.port);
      expect((yield* state.read(currentId))?.ports).toEqual([
        { key: "api", host: "127.0.0.1", port: rest.port },
      ]);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("lets exactly one of two stacks sharing a saved port bind it when both start at once", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const root = sharedStateRoot();
      const state = yield* makeTestState(root);
      const firstId = uniqueStackId("first");
      const secondId = uniqueStackId("second");
      yield* saveStack(state, root, firstId);
      const ports = yield* makePorts(state);
      const request = { stackId: firstId, key: "api", host: "127.0.0.1", port: "auto" as const };
      const seedScope = yield* Scope.make();
      const seed = yield* ports
        .acquire(request, bind)
        .pipe(Effect.provideService(Scope.Scope, seedScope));
      yield* Scope.close(seedScope, Exit.void);
      yield* saveStack(state, root, secondId, [{ key: "api", host: "127.0.0.1", port: seed.port }]);

      const [first, second] = yield* Effect.all(
        [
          Effect.exit(ports.acquire(request, bind)),
          Effect.exit(ports.acquire({ ...request, stackId: secondId }, bind)),
        ],
        { concurrency: "unbounded" },
      );
      const outcomes = [
        { claimant: secondId, exit: first },
        { claimant: firstId, exit: second },
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
      for (const id of [firstId, secondId])
        expect((yield* state.read(id))?.ports).toEqual([
          { key: "api", host: "127.0.0.1", port: seed.port },
        ]);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

// Fixed so a test can force two reservations to the same candidate; production uses randomPortSpanStart.
const fixedStart = Effect.succeed(0);

const noClaimedPorts: ReadonlySet<number> = new Set();

// Binds a real listener directly in the native-reservation span, retrying past occupied and
// claimed candidates, instead of reserving then releasing a port that something else could grab
// meanwhile.
const bindBlockingPort = (host: string, claimed: ReadonlySet<number> = noClaimedPorts) =>
  Effect.gen(function* () {
    for (let offset = 0; offset < portSpan; offset++) {
      const port = portBase + offset;
      if (claimed.has(port)) continue;
      const attempt = yield* Effect.exit(bind(host, port));
      if (Exit.isSuccess(attempt)) return { port, listener: attempt.value };
    }
    return yield* Effect.die("No port in the native reservation span was free for the fixture");
  });

it.live("skips a native backend port claimed by another saved stack", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const state = yield* makeTestState(root);
      const shared = yield* sharedPortClaims;

      const probeScope = yield* Scope.make();
      const probe = yield* reserveNativePort(shared, "pooler", fixedStart).pipe(
        Effect.provideService(Scope.Scope, probeScope),
      );
      yield* Scope.close(probeScope, Exit.void);

      yield* saveStack(state, root, "claimer", [
        { key: "db/sql", host: "127.0.0.1", port: probe.port },
      ]);

      // Starts at the claimed port with the same shared snapshot, so only the claim can skip it.
      const claimedStart = Effect.succeed(probe.port - portBase);
      const reserved = yield* reserveNativePort(
        [...(yield* state.claims), ...shared],
        "pooler",
        claimedStart,
      );
      expect(reserved.port).not.toBe(probe.port);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("skips a native backend port a wildcard listener holds", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const claims = yield* sharedPortClaims;
      const claimed = new Set(claims.flatMap((stack) => stack.ports.map((claim) => claim.port)));
      // A wildcard bind is reachable through loopback, so a loopback-only probe would miss it.
      const blocked = yield* bindBlockingPort("0.0.0.0", claimed);
      const forcedStart = Effect.succeed(blocked.port - portBase);

      const reserved = yield* reserveNativePort(claims, "pooler", forcedStart);
      expect(reserved.port).not.toBe(blocked.port);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("excludes a port a previous attempt lost from the next reservation", () =>
  Effect.scoped(
    Effect.gen(function* () {
      // Read once and reuse, so claims cannot change between the two reservations and newly
      // exclude the port on their own; only the `excluded` set may.
      const claims = yield* sharedPortClaims;
      const firstScope = yield* Scope.make();
      const first = yield* reserveNativePort(claims, "pooler", fixedStart).pipe(
        Effect.provideService(Scope.Scope, firstScope),
      );
      yield* Scope.close(firstScope, Exit.void);

      // Starts the scan at first's own port, so excluding it is the only reason the second
      // reservation can move past it.
      const secondStart = Effect.succeed(first.port - portBase);
      const second = yield* reserveNativePort(claims, "pooler", secondStart, new Set([first.port]));
      expect(second.port).not.toBe(first.port);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

// Mirrors the unexported `scanStart` in ./Ports.ts; several stories below need a competitor id
// whose own first candidate collides with another stack's port.
const scanStart = (projectRoot: string, id: string, key: string) =>
  Math.abs(Hash.string(`${projectRoot}:${id}:${key}`)) % portSpan;

/** Brute-forces a stack id whose first automatic candidate is `target`, dying if none is found. */
const findScanStartCollision = (projectRoot: string, key: string, target: number) =>
  Effect.gen(function* () {
    for (let suffix = 0; suffix < 200_000; suffix++) {
      const candidate = `competitor-${suffix}`;
      if (scanStart(projectRoot, candidate, key) === target) return candidate;
    }
    return yield* Effect.die(`No id shares candidate ${target} as its own first scan candidate`);
  });

it.live("skips a public auto candidate a loopback listener already holds", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const root = sharedStateRoot();
      const state = yield* makeTestState(root);
      const stackId = uniqueStackId("stack");
      yield* saveStack(state, root, stackId);
      const ports = yield* makePorts(state);
      // A container-runtime stack's bind to the wildcard host would otherwise succeed here too.
      const request = { stackId, key: "api", host: "0.0.0.0", port: "auto" as const };
      const accept = (_host: string, port: number) => Effect.succeed(port);

      // Releasing the claim, rather than closing its scope, leaves the listener live while
      // freeing the port for anyone's claims-based scan.
      const probe = yield* ports.acquire(request, (_host, port) => bind("127.0.0.1", port));
      yield* ports.release(stackId, "api");

      // A competitor whose own first candidate is probe's port proves the skip can only come
      // from loopbackOccupied finding the still-live listener, not from a claims-based skip.
      const competitorId = yield* findScanStartCollision(root, "api", probe.port - portBase);
      yield* saveStack(state, root, competitorId);

      const acquired = yield* ports.acquire({ ...request, stackId: competitorId }, accept);
      expect(acquired.port).not.toBe(probe.port);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live(
  "keeps automatic allocation off a stopped sibling's saved port that is its own first candidate",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const projectRoot = yield* fs.makeTempDirectoryScoped({
          prefix: "ports-sibling-project-",
        });
        const key = "sql";
        const firstId = uniqueStackId("first");
        const accept = (_host: string, port: number) => Effect.succeed(port);
        const request = { stackId: firstId, key, host: "127.0.0.1", port: "auto" as const };

        // `first` lives on the shared root, so every other suite allocator already sees its
        // claim once saved; its actual port (not a prediction) names the candidate to collide.
        const sharedRoot = sharedStateRoot();
        const sharedState = yield* makeTestState(sharedRoot);
        yield* saveStack(sharedState, projectRoot, firstId);
        const sharedPorts = yield* makePorts(sharedState, "linux");
        const firstScope = yield* Scope.make();
        const firstAcquired = yield* sharedPorts
          .acquire(request, accept)
          .pipe(Effect.provideService(Scope.Scope, firstScope));
        yield* Scope.close(firstScope, Exit.void);
        const competitorId = yield* findScanStartCollision(
          projectRoot,
          key,
          firstAcquired.port - portBase,
        );

        // Proves the prerequisite: alone, in a private root, the competitor's own first
        // candidate is the same port.
        const verifyRoot = yield* fs.makeTempDirectoryScoped({ prefix: "ports-sibling-verify-" });
        const verifyState = yield* makeTestState(verifyRoot);
        yield* saveStack(verifyState, projectRoot, competitorId);
        const verifyPorts = yield* makePorts(verifyState, "linux");
        const verifyAcquired = yield* verifyPorts.acquire(
          { ...request, stackId: competitorId },
          accept,
        );
        expect(verifyAcquired.port).toBe(firstAcquired.port);

        yield* saveStack(sharedState, projectRoot, competitorId);
        const competitorAcquired = yield* sharedPorts.acquire(
          { ...request, stackId: competitorId },
          accept,
        );
        expect(competitorAcquired.port).not.toBe(firstAcquired.port);

        const reopenedPorts = yield* makePorts(yield* makeTestState(sharedRoot), "linux");
        const firstReacquired = yield* reopenedPorts.acquire(request, accept);
        expect(firstReacquired.port).toBe(firstAcquired.port);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);
