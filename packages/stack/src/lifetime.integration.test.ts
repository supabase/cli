import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import {
  Context,
  Data,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Path,
  Schema,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { create, open } from "./effect.ts";
import * as State from "./State.ts";
import { assertOwnerExited, captureOwnerPid, watchLeaseRelease } from "../tests/owner.ts";

class LifetimeTestError extends Data.TaggedError("LifetimeTestError")<{
  readonly message: string;
}> {}

const layer = Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp);
const cacheRoot = `${tmpdir()}/supabase-stack-artifacts`;
const sessionFixture = fileURLToPath(
  new URL("../tests/session-client-fixture.ts", import.meta.url),
);

const stateFor = (root: string) =>
  Layer.build(State.layer({ root })).pipe(
    Effect.map((context) => Context.get(context, State.Service)),
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

/** Completes once `entry` disappears from `directory`; subscribe before triggering the removal. */
const awaitRemoval = (directory: string, entry: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const target = path.join(directory, entry);
    yield* fs.watch(directory).pipe(
      Stream.filter((event) => event.path === entry || event.path === target),
      Stream.mapEffect(() => fs.exists(target)),
      Stream.takeUntil((exists) => !exists),
      Stream.runDrain,
    );
  });

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
      expect((yield* state.claims).find(({ id }) => id === stackId)?.ports.length).toBeGreaterThan(
        0,
      );
      const ownerPid = yield* captureOwnerPid({ stateRoot, cacheRoot }, stackId);
      const owned = yield* descendantsOf(ownerPid);
      expect(owned.length, "the owner runs the native mail service").toBeGreaterThan(0);

      const removed = yield* awaitRemoval(stateRoot, stackId).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      const released = yield* watchLeaseRelease(stateRoot, stackId);
      yield* creator.kill({ killSignal: "SIGKILL" });
      yield* Fiber.join(removed).pipe(
        Effect.timeoutOrElse({
          duration: "1 minute",
          orElse: () =>
            Effect.fail(new LifetimeTestError({ message: "Session stack was not destroyed" })),
        }),
      );

      // Releasing the lease is the owner's last act, after its native processes have exited.
      yield* released;
      expect(owned.filter(alive), "native processes die with their owner").toEqual([]);
      expect(yield* fs.exists(`${stateRoot}/${stackId}`)).toBe(false);
      expect((yield* state.claims).some(({ id }) => id === stackId)).toBe(false);
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
    expect(yield* fs.exists(`${locations.stateRoot}/${id}`)).toBe(false);
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
