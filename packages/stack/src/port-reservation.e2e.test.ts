import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Cause, Context, Effect, Exit, FileSystem, Layer, Option } from "effect";
import * as Net from "node:net";
import { create, open, type Observation } from "./effect.ts";
import { ownerExitProbe, waitForOwnerExit } from "./HostProcess.ts";
import * as PortReservations from "./namespace/PortReservations.ts";
import * as StackNamespace from "./StackNamespace.ts";
import { captureOwnerPid } from "../tests/owner.ts";
import { destroyTestStack } from "../tests/stack-cleanup.ts";

/**
 * Step 1.4's per-user port reservation registry: a stopped stack keeps its public ports across
 * every other stack's starts and across state roots, a restart recovers the same ports or fails
 * with a structured `PortConflict`, and destroy (but never stop or a kill) releases them.
 */

const servicesLayer = Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp);
const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(effect).pipe(Effect.provide(servicesLayer));

const mailOn = (port: number | "auto") =>
  ({ service: "mail" as const, config: {}, endpoints: { http: { port } } }) as const;

const portOf = (observation: Observation): number => {
  const endpoint = observation.endpoints.find((candidate) => candidate.name === "http");
  if (endpoint === undefined) throw new Error(`Missing http endpoint in ${observation.id}`);
  return endpoint.port;
};

/** A plain external listener, not a stack, holding `host:port` outside this package entirely. */
const foreignListener = (host: string, port: number) =>
  Effect.acquireRelease(
    Effect.callback<Net.Server, Error>((resume) => {
      const server = Net.createServer();
      server.once("error", (cause) => resume(Effect.fail(cause)));
      server.listen(port, host, () => resume(Effect.succeed(server)));
    }),
    (server) =>
      Effect.callback<void>((resume) => {
        server.close(() => resume(Effect.void));
      }),
  );

const makeStack = Effect.fn("PortReservation.makeStack")(function* (
  fs: FileSystem.FileSystem,
  cacheRoot: string,
  runtime: "native" | "docker" = "native",
) {
  const root = yield* fs.makeTempDirectoryScoped({ prefix: `port-reservation-${runtime}-` });
  const stack = yield* create({
    projectRoot: root,
    stateRoot: `${root}/state`,
    cacheRoot,
    runtime,
  });
  yield* Effect.addFinalizer(() => destroyTestStack(stack));
  return { stack, stateRoot: `${root}/state` };
});

const conflictHolderStackId = (exit: Exit.Exit<unknown, unknown>) => {
  if (Exit.isSuccess(exit)) return undefined;
  const failure = Cause.findErrorOption(exit.cause);
  if (Option.isNone(failure)) return undefined;
  const error = failure.value as { readonly conflict?: { readonly holder?: unknown } };
  const holder = error.conflict?.holder;
  return typeof holder === "object" && holder !== null && "stackId" in holder
    ? (holder as { readonly stackId: string }).stackId
    : undefined;
};

const conflictIsForeign = (exit: Exit.Exit<unknown, unknown>) => {
  if (Exit.isSuccess(exit)) return false;
  const failure = Cause.findErrorOption(exit.cause);
  if (Option.isNone(failure)) return false;
  const error = failure.value as { readonly conflict?: { readonly holder?: unknown } };
  return error.conflict?.holder === "foreign";
};

/**
 * Runs `use` with `HOME` pointed at `home`; a spawned owner inherits it at spawn time. Restored
 * afterward, so this only ever affects the one owner launched inside `use`.
 */
const withFakeHome = <A, E, R>(home: string, use: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      // oxlint-disable-next-line effecttsgo/process-env-in-effect, effecttsgo/process-env -- a one-shot, restored test fixture, not application config.
      const previous = process.env.HOME;
      // oxlint-disable-next-line effecttsgo/process-env-in-effect, effecttsgo/process-env -- see above.
      process.env.HOME = home;
      return previous;
    }),
    () => use,
    (previous) =>
      Effect.sync(() => {
        // oxlint-disable-next-line effecttsgo/process-env-in-effect, effecttsgo/process-env -- restores the mutation made above.
        if (previous === undefined) delete process.env.HOME;
        // oxlint-disable-next-line effecttsgo/process-env-in-effect, effecttsgo/process-env -- restores the mutation made above.
        else process.env.HOME = previous;
      }),
  );

it.live(
  "a stopped stack's reserved port survives another stack's start in a different state root; a fixed claim on it is a structured PortConflict naming the holder, and the stack restarts on the same port",
  () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cacheRoot = yield* fs.makeTempDirectoryScoped({ prefix: "port-reservation-cache-" });
        const { stack: stackA, stateRoot: stateRootA } = yield* makeStack(fs, cacheRoot);
        const mailA = yield* stackA.services.create(mailOn("auto"));
        yield* mailA.start;
        yield* mailA.ready;
        const port = portOf(yield* mailA.status);

        // A is stopped, not destroyed: its registration, and the public port it was given, persist.
        // `Stack.stop` already confirms the owner (and so its listener) has exited.
        yield* stackA.stop;

        const { stack: stackB } = yield* makeStack(fs, cacheRoot);
        const mailB = yield* stackB.services.create(mailOn(port));
        const startB = yield* Effect.exit(mailB.start);
        expect(Exit.isFailure(startB)).toBe(true);
        expect(conflictHolderStackId(startB)).toBe(stackA.id);

        // A's restart recovers its own reserved port; B never legitimately held it.
        const reopenedA = yield* open({ id: stackA.id, stateRoot: stateRootA, cacheRoot });
        const reopenedMailA = yield* reopenedA.services.get(mailA.id);
        yield* reopenedMailA.start;
        yield* reopenedMailA.ready;
        expect(portOf(yield* reopenedMailA.status)).toBe(port);

        // Destroy releases the reservation: a third stack can now claim the exact same port.
        yield* reopenedA.destroy;
        const { stack: stackC } = yield* makeStack(fs, cacheRoot);
        const mailC = yield* stackC.services.create(mailOn(port));
        yield* mailC.start;
        yield* mailC.ready;
        expect(portOf(yield* mailC.status)).toBe(port);
      }),
    ),
  { timeout: 120_000 },
);

it.live(
  "a SIGKILLed owner's reservation survives: another stack's claim on its port is a conflict, the original restarts on the same port, and destroy then releases it",
  () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cacheRoot = yield* fs.makeTempDirectoryScoped({
          prefix: "port-reservation-kill-cache-",
        });
        const { stack: stackA, stateRoot: stateRootA } = yield* makeStack(fs, cacheRoot);
        const mailA = yield* stackA.services.create(mailOn("auto"));
        yield* mailA.start;
        yield* mailA.ready;
        const port = portOf(yield* mailA.status);

        const pid = yield* captureOwnerPid({ stateRoot: stateRootA, cacheRoot }, stackA.id);
        yield* Effect.sync(() => process.kill(pid, "SIGKILL"));
        // The owner's own exit already confirms the kernel has reclaimed its listeners.
        yield* waitForOwnerExit(pid, ownerExitProbe(fs));

        const { stack: stackB } = yield* makeStack(fs, cacheRoot);
        const mailB = yield* stackB.services.create(mailOn(port));
        const startB = yield* Effect.exit(mailB.start);
        expect(Exit.isFailure(startB)).toBe(true);
        expect(conflictHolderStackId(startB)).toBe(stackA.id);

        const reopenedA = yield* open({ id: stackA.id, stateRoot: stateRootA, cacheRoot });
        const reopenedMailA = yield* reopenedA.services.get(mailA.id);
        yield* reopenedMailA.start;
        yield* reopenedMailA.ready;
        expect(portOf(yield* reopenedMailA.status)).toBe(port);

        yield* reopenedA.destroy;
        const { stack: stackC } = yield* makeStack(fs, cacheRoot);
        const mailC = yield* stackC.services.create(mailOn(port));
        yield* mailC.start;
        yield* mailC.ready;
        expect(portOf(yield* mailC.status)).toBe(port);
      }),
    ),
  { timeout: 120_000 },
);

it.live(
  "a foreign listener occupying a stopped stack's saved port fails its restart as a PortConflict(foreign), never reassigning it",
  () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cacheRoot = yield* fs.makeTempDirectoryScoped({
          prefix: "port-reservation-foreign-cache-",
        });
        const { stack: stackA, stateRoot: stateRootA } = yield* makeStack(fs, cacheRoot);
        const mailA = yield* stackA.services.create(mailOn("auto"));
        yield* mailA.start;
        yield* mailA.ready;
        const port = portOf(yield* mailA.status);

        yield* stackA.stop;

        const reopenedA = yield* open({ id: stackA.id, stateRoot: stateRootA, cacheRoot });
        const reopenedMailA = yield* reopenedA.services.get(mailA.id);

        // A process outside the registry occupies A's saved port for exactly this inner scope.
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* foreignListener("127.0.0.1", port);
            const restartA = yield* Effect.exit(reopenedMailA.start);
            expect(Exit.isFailure(restartA)).toBe(true);
            expect(conflictIsForeign(restartA)).toBe(true);
          }),
        );

        // Never reassigned: once the foreign listener goes away, the retry recovers the same port.
        yield* reopenedMailA.start;
        yield* reopenedMailA.ready;
        expect(portOf(yield* reopenedMailA.status)).toBe(port);
      }),
    ),
  { timeout: 120_000 },
);

it.live(
  "deleting a stopped stack's state root makes its reserved ports reclaimable by another stack",
  () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cacheRoot = yield* fs.makeTempDirectoryScoped({
          prefix: "port-reservation-reclaim-cache-",
        });
        // Plain (unscoped): this test deletes `root` itself, so no scope finalizer should also
        // try to remove it afterward.
        const root = yield* fs.makeTempDirectory({ prefix: "port-reservation-reclaim-a-" });
        const stateRootA = `${root}/state`;
        const stackA = yield* create({
          projectRoot: root,
          stateRoot: stateRootA,
          cacheRoot,
          runtime: "native",
        });
        const mailA = yield* stackA.services.create(mailOn("auto"));
        yield* mailA.start;
        yield* mailA.ready;
        const port = portOf(yield* mailA.status);
        yield* stackA.stop;

        // The whole state root disappears without going through destroy (an unmounted volume, or a
        // deleted checkout): a confirmed ENOENT on its registration is what makes its row stale.
        yield* fs.remove(root, { recursive: true, force: true });

        const { stack: stackB } = yield* makeStack(fs, cacheRoot);
        const mailB = yield* stackB.services.create(mailOn(port));
        yield* mailB.start;
        yield* mailB.ready;
        expect(portOf(yield* mailB.status)).toBe(port);
      }),
    ),
  { timeout: 120_000 },
);

it.live(
  "a native and a Docker stack racing for the same reserved port never both succeed",
  () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cacheRoot = yield* fs.makeTempDirectoryScoped({
          prefix: "port-reservation-backend-cache-",
        });
        // Destroyed, not merely stopped, so the port is genuinely free for B and C to race over;
        // a stopped stack would keep the row and both racers would lose to it instead.
        const { stack: stackA } = yield* makeStack(fs, cacheRoot, "native");
        const mailA = yield* stackA.services.create(mailOn("auto"));
        yield* mailA.start;
        yield* mailA.ready;
        const port = portOf(yield* mailA.status);
        yield* stackA.destroy;

        const { stack: stackB } = yield* makeStack(fs, cacheRoot, "native");
        const { stack: stackC } = yield* makeStack(fs, cacheRoot, "docker");
        const mailB = yield* stackB.services.create(mailOn(port));
        const mailC = yield* stackC.services.create(mailOn(port));
        const [exitB, exitC] = yield* Effect.all(
          [Effect.exit(mailB.start), Effect.exit(mailC.start)],
          { concurrency: "unbounded" },
        );
        const successes = [exitB, exitC].filter(Exit.isSuccess);
        expect(successes).toHaveLength(1);
        const loser = Exit.isFailure(exitB) ? exitB : exitC;
        expect(conflictHolderStackId(loser)).toBeDefined();
      }),
    ),
  { timeout: 180_000 },
);

it.live(
  "an owner spawned with HOME pointed elsewhere still reserves in the real per-user registry",
  () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cacheRoot = yield* fs.makeTempDirectoryScoped({
          prefix: "port-reservation-home-cache-",
        });
        const { stack: stackA } = yield* makeStack(fs, cacheRoot);
        const mailA = yield* stackA.services.create(mailOn("auto"));
        yield* mailA.start;
        yield* mailA.ready;
        const port = portOf(yield* mailA.status);

        const fakeHome = yield* fs.makeTempDirectoryScoped({
          prefix: "port-reservation-fake-home-",
        });
        // The owner is spawned lazily, on this stack's first RPC call; the fake HOME must still be
        // set when that happens, so the whole setup runs inside the same window.
        const startB = yield* withFakeHome(
          fakeHome,
          Effect.gen(function* () {
            const { stack: stackB } = yield* makeStack(fs, cacheRoot);
            const mailB = yield* stackB.services.create(mailOn(port));
            return yield* Effect.exit(mailB.start);
          }),
        );
        expect(Exit.isFailure(startB)).toBe(true);
        expect(conflictHolderStackId(startB)).toBe(stackA.id);
      }),
    ),
  { timeout: 120_000 },
);

it.live(
  "a restart republishes state.json when the registry already holds a port its saved claim forgot",
  () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cacheRoot = yield* fs.makeTempDirectoryScoped({
          prefix: "port-reservation-desync-cache-",
        });
        const { stack: stackA, stateRoot: stateRootA } = yield* makeStack(fs, cacheRoot);
        const mailA = yield* stackA.services.create(mailOn("auto"));
        yield* mailA.start;
        yield* mailA.ready;
        const port = portOf(yield* mailA.status);
        yield* stackA.stop;

        // Simulate a crash between the registry commit and the local `state.json` publish: the
        // registry still names this port, but the saved claim that mirrors it is gone.
        const state = yield* StackNamespace.Service.pipe(
          Effect.provide(StackNamespace.layer({ root: stateRootA })),
        );
        const saved = yield* state.read(stackA.id);
        if (saved === undefined) return yield* Effect.die("stack state missing");
        yield* state.save({ ...saved, ports: [] });

        const reopenedA = yield* open({ id: stackA.id, stateRoot: stateRootA, cacheRoot });
        const reopenedMailA = yield* reopenedA.services.get(mailA.id);
        yield* reopenedMailA.start;
        yield* reopenedMailA.ready;
        expect(portOf(yield* reopenedMailA.status)).toBe(port);
        expect((yield* state.read(stackA.id))?.ports.some((entry) => entry.port === port)).toBe(
          true,
        );
      }),
    ),
  { timeout: 120_000 },
);

it.live(
  "a restart re-establishes a registry row its saved claim remembers but the registry lost",
  () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cacheRoot = yield* fs.makeTempDirectoryScoped({
          prefix: "port-reservation-missing-row-cache-",
        });
        const { stack: stackA, stateRoot: stateRootA } = yield* makeStack(fs, cacheRoot);
        const mailA = yield* stackA.services.create(mailOn("auto"));
        yield* mailA.start;
        yield* mailA.ready;
        const port = portOf(yield* mailA.status);
        yield* stackA.stop;

        // Simulate the registry row disappearing independently of `state.json` (for example, a
        // registry file replaced out from under a stopped stack): the saved claim still names the
        // port, but no row backs it.
        const realStateRoot = yield* fs.realPath(stateRootA);
        const reservationContext = yield* Layer.build(PortReservations.layer);
        const portReservations = Context.get(reservationContext, PortReservations.Service);
        yield* portReservations.release(realStateRoot, stackA.id, `${mailA.id}:http`);

        const reopenedA = yield* open({ id: stackA.id, stateRoot: stateRootA, cacheRoot });
        const reopenedMailA = yield* reopenedA.services.get(mailA.id);
        yield* reopenedMailA.start;
        yield* reopenedMailA.ready;
        expect(portOf(yield* reopenedMailA.status)).toBe(port);
        expect(yield* portReservations.find(realStateRoot, stackA.id, `${mailA.id}:http`)).toBe(
          port,
        );
      }),
    ),
  { timeout: 120_000 },
);

it.live(
  "composing a member on an already-claimed port surfaces a structured conflict naming the holder",
  () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cacheRoot = yield* fs.makeTempDirectoryScoped({
          prefix: "port-reservation-composition-cache-",
        });
        const { stack: stackA } = yield* makeStack(fs, cacheRoot);
        const mailA = yield* stackA.services.create(mailOn("auto"));
        yield* mailA.start;
        yield* mailA.ready;
        const port = portOf(yield* mailA.status);

        // The composition registers every member's public port up front, including a lazy
        // one like mail, so the conflict surfaces here rather than at a later `.start()`.
        const { stack: stackB } = yield* makeStack(fs, cacheRoot);
        const composeB = yield* Effect.exit(stackB.composition.supabase([mailOn(port)]));
        expect(Exit.isFailure(composeB)).toBe(true);
        expect(conflictHolderStackId(composeB)).toBe(stackA.id);
      }),
    ),
  { timeout: 120_000 },
);

it.live(
  "restarting a composition surfaces a structured conflict from one member's own failing outcome",
  () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cacheRoot = yield* fs.makeTempDirectoryScoped({
          prefix: "port-reservation-composition-outcome-cache-",
        });
        const { stack } = yield* makeStack(fs, cacheRoot);
        const members = yield* stack.composition.supabase([mailOn("auto")]);
        yield* stack.composition.start;
        const statuses = yield* Effect.forEach(members, (member) => member.status);
        const mail = statuses.find((status) => status.config.service === "mail");
        if (mail === undefined) return yield* Effect.die("mail missing from the composition");
        const port = portOf(mail);
        yield* stack.composition.stop;

        // Composing and starting cleanly the first time means the top-level failure below cannot
        // itself carry the conflict; only `startComposition`'s own per-member outcome does.
        yield* foreignListener("127.0.0.1", port);
        const restart = yield* Effect.exit(stack.composition.start);
        expect(Exit.isFailure(restart)).toBe(true);
        expect(conflictIsForeign(restart)).toBe(true);
      }),
    ),
  { timeout: 120_000 },
);
