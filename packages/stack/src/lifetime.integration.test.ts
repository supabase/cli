import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Context, Data, Effect, Fiber, FileSystem, Layer, Option, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { fileURLToPath } from "node:url";
import { create, open } from "./effect.ts";
import { launchHost, ownerClient, ownerExitProbe, waitForOwnerExit } from "./HostProcess.ts";
import * as StackNamespace from "./StackNamespace.ts";
import {
  assertOwnerExited,
  captureOwnerPid,
  shutdownOwner,
  watchLeaseRelease,
} from "../tests/owner.ts";
import { watchEntry } from "../tests/watch-entry.ts";
import { testArtifactCacheRoot } from "../tests/artifact-cache.ts";

class LifetimeTestError extends Data.TaggedError("LifetimeTestError")<{
  readonly message: string;
}> {}

const layer = Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp);
const cacheRoot = testArtifactCacheRoot;
const sessionFixture = fileURLToPath(
  new URL("../tests/session-client-fixture.ts", import.meta.url),
);
const shortRegistrationPollFixture = fileURLToPath(
  new URL("../tests/short-registration-poll-fixture.ts", import.meta.url),
);

const stateFor = (root: string) =>
  Layer.build(StackNamespace.layer({ root })).pipe(
    Effect.map((context) => Context.get(context, StackNamespace.Service)),
  );

const collect = (child: ChildProcessSpawner.ChildProcessHandle) =>
  Effect.all(
    [
      child.stdout.pipe(Stream.decodeText, Stream.mkString),
      child.stderr.pipe(Stream.decodeText, Stream.mkString),
      child.exitCode,
    ],
    { concurrency: "unbounded" },
  );

/** Lists the live descendants of `pid` from the process table. */
const descendantsOf = Effect.fn("LifetimeTest.descendantsOf")(function* (pid: number) {
  const [table] = yield* Effect.scoped(
    ChildProcess.make("ps", ["-axo", "pid=,ppid="], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    }).pipe(Effect.flatMap(collect)),
  );
  const children = new Map<number, Array<number>>();
  for (const line of table.split("\n")) {
    const [child, parent] = line.trim().split(/\s+/u).map(Number);
    if (child === undefined || parent === undefined || Number.isNaN(child)) continue;
    children.set(parent, [...(children.get(parent) ?? []), child]);
  }
  const found: Array<number> = [];
  const pending = [pid];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const direct = children.get(next) ?? [];
    found.push(...direct);
    pending.push(...direct);
  }
  return found;
});

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

it.live.skipIf(process.platform === "win32")(
  "destroys a session stack and its native processes when the creating process is killed",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-session-kill-" });
      const stateRoot = `${root}/state`;
      const creator = yield* ChildProcess.make(
        process.execPath,
        [sessionFixture, root, cacheRoot],
        {
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const stderr = yield* creator.stderr.pipe(
        Stream.decodeText,
        Stream.mkString,
        Effect.forkScoped,
      );
      const ready = yield* creator.stdout.pipe(
        Stream.decodeText,
        Stream.splitLines,
        Stream.runHead,
        Effect.timeout("2 minutes"),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Fiber.join(stderr).pipe(
                Effect.flatMap((diagnostics) =>
                  Effect.fail(
                    new LifetimeTestError({
                      message: `Session creator exited before readiness: ${diagnostics}`,
                    }),
                  ),
                ),
              ),
            onSome: Effect.succeed,
          }),
        ),
      );
      const { stackId } = yield* Schema.decodeEffect(
        Schema.fromJsonString(Schema.Struct({ stackId: Schema.String })),
      )(ready);
      const state = yield* stateFor(stateRoot);
      expect(yield* state.leased(stackId)).toBe(true);
      const ownerPid = yield* captureOwnerPid({ stateRoot, cacheRoot }, stackId);
      const owned = yield* descendantsOf(ownerPid);
      expect(owned.length, "the owner runs the native mail service").toBeGreaterThan(0);

      const removed = yield* watchEntry(`${stateRoot}/${stackId}`, "state.json", false);
      const released = yield* watchLeaseRelease(stateRoot, stackId);
      yield* creator.kill({ killSignal: "SIGKILL" });
      yield* removed.pipe(
        Effect.timeoutOrElse({
          duration: "1 minute",
          orElse: () =>
            Effect.fail(new LifetimeTestError({ message: "Session stack was not destroyed" })),
        }),
      );

      // Releasing the lease is the owner's last act, after its native processes have exited.
      yield* released;
      expect(owned.filter(alive), "native processes die with their owner").toEqual([]);
      expect(yield* fs.exists(`${stateRoot}/${stackId}/state.json`)).toBe(false);
      expect(yield* state.read(stackId)).toBeUndefined();
    }).pipe(Effect.scoped, Effect.provide(layer)),
  { timeout: 180_000 },
);

it.live("destroys a session stack when its creating handle closes", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-session-close-" });
    const locations = { stateRoot: `${root}/state`, cacheRoot };
    const { id, ownerPid } = yield* Effect.scoped(
      Effect.gen(function* () {
        const stack = yield* create({
          ...locations,
          projectRoot: root,
          runtime: "native",
          lifetime: "session",
        });
        expect(yield* stack.composition.start).toEqual([]);
        return { id: stack.id, ownerPid: yield* captureOwnerPid(locations, stack.id) };
      }),
    );
    yield* assertOwnerExited(ownerPid);
    const state = yield* stateFor(locations.stateRoot);
    expect(yield* state.read(id)).toBeUndefined();
    expect(yield* fs.exists(`${locations.stateRoot}/${id}/state.json`)).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.live("lets only the creating handle start a session stack's owner", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-session-attach-" });
    const locations = { stateRoot: `${root}/state`, cacheRoot };
    const id = yield* Effect.scoped(
      Effect.gen(function* () {
        const stack = yield* create({
          ...locations,
          projectRoot: root,
          runtime: "native",
          lifetime: "session",
        });
        const other = yield* open({ ...locations, id: stack.id });
        expect(yield* other.composition.start).toEqual([]);
        yield* other.stop;

        const refused = yield* Effect.flip(other.composition.start);
        expect(refused.message).toContain("has no live owner");

        expect(yield* stack.composition.start).toEqual([]);
        expect(yield* other.composition.stop).toEqual([]);
        return stack.id;
      }),
    );
    const state = yield* stateFor(locations.stateRoot);
    expect(yield* state.read(id)).toBeUndefined();
    expect(yield* state.leased(id)).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.live.skipIf(process.platform === "win32")(
  "exits and stops its native workload, freeing its port, when its registration is confirmed gone",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-registration-lost-native-" });
      const stateRoot = `${root}/state`;
      const state = yield* stateFor(stateRoot);
      const stackId = "registration-lost-native";
      yield* state.save({
        id: stackId,
        runtime: "native",
        identity: { projectRoot: root, branchContext: "main", stackName: stackId },
        instances: [],
        lifetime: "detached",
        composition: { members: [], dependencies: [] },
      });
      // The shortened poll interval comes only from this dedicated test entrypoint, through
      // the internal `Context.Reference`; production startup never reads an env var or `Config`.
      const access = yield* launchHost(state, {
        stateRoot,
        cacheRoot,
        stackId,
        entrypoint: shortRegistrationPollFixture,
      });
      const client = yield* ownerClient(access);
      const mail = yield* client.createService({
        service: "mail",
        config: {},
        endpoints: { http: { port: "auto" } },
      });
      yield* client.startService({ id: mail.id });
      yield* client.readyService({ id: mail.id });
      const status = yield* client.status({ id: mail.id });
      const port = status.endpoints.find((endpoint) => endpoint.name === "http")?.port;
      if (port === undefined) return yield* Effect.die("Missing mail http endpoint");
      const ownerPid = access.endpoint.pid;
      const owned = yield* descendantsOf(ownerPid);
      expect(owned.length, "the owner runs the native mail service").toBeGreaterThan(0);

      // Subscribes to the owner's own exit signal (its lease release, the owner's last act) before
      // triggering the deletion, rather than polling for it afterward.
      const leaseReleased = yield* watchLeaseRelease(stateRoot, stackId);
      yield* fs.remove(`${stateRoot}/${stackId}/state.json`);
      yield* leaseReleased;
      // The lease is already confirmed released, so the process is already exiting or exited;
      // `waitForOwnerExit`'s own internal cap no longer bounds detection, drain and cleanup — only
      // this final, now-fast confirmation.
      yield* waitForOwnerExit(ownerPid, ownerExitProbe(fs)).pipe(Effect.timeout("10 seconds"));

      expect(owned.filter(alive), "native processes die with their owner").toEqual([]);
      expect(
        yield* fs.exists(`${stateRoot}/${stackId}/state.json`),
        "no registration is republished",
      ).toBe(false);

      // The stopped workload frees its port: a fresh stack can claim the exact same port.
      const reclaimedRoot = yield* fs.makeTempDirectoryScoped({
        prefix: "stack-registration-lost-native-reclaim-",
      });
      const reclaimedStateRoot = `${reclaimedRoot}/state`;
      const reclaimedState = yield* stateFor(reclaimedStateRoot);
      const reclaimedId = "registration-lost-native-reclaim";
      yield* reclaimedState.save({
        id: reclaimedId,
        runtime: "native",
        identity: { projectRoot: reclaimedRoot, branchContext: "main", stackName: reclaimedId },
        instances: [],
        lifetime: "detached",
        composition: { members: [], dependencies: [] },
      });
      const reclaimedAccess = yield* launchHost(reclaimedState, {
        stateRoot: reclaimedStateRoot,
        cacheRoot,
        stackId: reclaimedId,
      });
      const reclaimedClient = yield* ownerClient(reclaimedAccess);
      const reclaimedMail = yield* reclaimedClient.createService({
        service: "mail",
        config: {},
        endpoints: { http: { port } },
      });
      yield* reclaimedClient.startService({ id: reclaimedMail.id });
      yield* reclaimedClient.readyService({ id: reclaimedMail.id });
      const reclaimedStatus = yield* reclaimedClient.status({ id: reclaimedMail.id });
      expect(reclaimedStatus.endpoints.find((endpoint) => endpoint.name === "http")?.port).toBe(
        port,
      );
      yield* shutdownOwner(reclaimedAccess, true);
      yield* waitForOwnerExit(reclaimedAccess.endpoint.pid, ownerExitProbe(fs)).pipe(
        Effect.timeout("15 seconds"),
      );
    }).pipe(Effect.scoped, Effect.provide(layer)),
  { timeout: 60_000 },
);
