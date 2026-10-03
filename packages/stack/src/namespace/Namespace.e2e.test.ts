import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import {
  Context,
  Data,
  Deferred,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Path,
  Ref,
  Schema,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { fileURLToPath } from "node:url";
import {
  connectHost,
  launchHost,
  ownerExitProbe,
  shutdownHost,
  waitForOwnerExit,
} from "../HostProcess.ts";
import { create, open } from "../effect.ts";
import * as StackNamespace from "../StackNamespace.ts";
import { captureOwnerPid, watchLeaseRelease } from "../../tests/owner.ts";

class PublishBarrierError extends Data.TaggedError("PublishBarrierError")<{
  readonly message: string;
}> {}
class LockFixtureError extends Data.TaggedError("LockFixtureError")<{
  readonly message: string;
}> {}

const makeTestState = (root: string) =>
  Layer.build(StackNamespace.layer({ root })).pipe(
    Effect.map((context) => Context.get(context, StackNamespace.Service)),
  );

const ownerFixture = fileURLToPath(new URL("../../tests/host-process-fixture.ts", import.meta.url));
const publishLoopFixture = fileURLToPath(
  new URL("../../tests/publish-loop-fixture.ts", import.meta.url),
);
const lockFixture = fileURLToPath(
  new URL("../../tests/namespace-lock-fixture.ts", import.meta.url),
);

const testLayer = Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp);

const savedStack = (root: string, id: string): StackNamespace.SavedStack => ({
  id,
  runtime: "native",
  identity: { projectRoot: root, branchContext: "main", stackName: "local" },
  instances: [],
  lifetime: "detached",
  composition: { members: [], dependencies: [] },
  ports: [],
});

it.live(
  "a new owner acquires a SIGKILLed owner's lease, with no manual cleanup",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        // Scoped outside the owners: their scope below must fully close (confirming the second
        // owner has actually exited, not just acknowledged shutdown) before this directory's own
        // removal runs, or Windows reports EBUSY on a file the still-exiting owner has open.
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "namespace-e2e-sigkill-" });
        const state = yield* makeTestState(root);
        const id = "stack";
        yield* state.save(savedStack(root, id));
        const options = { stateRoot: root, cacheRoot: root, stackId: id, entrypoint: ownerFixture };

        yield* Effect.scoped(
          Effect.gen(function* () {
            const first = yield* launchHost(state, options);
            expect(yield* state.leased(id)).toBe(true);

            const released = yield* watchLeaseRelease(root, id);
            yield* Effect.sync(() => process.kill(first.endpoint.pid, "SIGKILL"));
            yield* released;
            expect(yield* state.leased(id)).toBe(false);

            // No file is removed or repaired here; the kernel alone released the dead owner's lease.
            const second = yield* Effect.acquireRelease(launchHost(state, options), (access) =>
              shutdownHost(access, true).pipe(
                Effect.ignore,
                Effect.andThen(
                  waitForOwnerExit(access.endpoint.pid, ownerExitProbe(fs)).pipe(Effect.ignore),
                ),
              ),
            );
            expect(second.endpoint.pid).not.toBe(first.endpoint.pid);
            expect(yield* connectHost(state, id)).toEqual(second);
          }),
        );
      }),
    ).pipe(Effect.provide(testLayer)),
  20_000,
);

it.live(
  "killing a writer exactly at the staging-to-publish boundary leaves the prior document intact and lets the next publish recover",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "namespace-e2e-publish-" });
        const state = yield* makeTestState(root);
        const id = "stack";
        yield* state.save(savedStack(root, id));

        const writer = yield* spawner.spawn(
          ChildProcess.make(process.execPath, [publishLoopFixture, root, id], {
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
          }),
        );
        const ready = yield* Deferred.make<void>();
        const stderr = yield* Ref.make("");
        const diagnostics = yield* writer.stderr.pipe(
          Stream.decodeText,
          Stream.runForEach((chunk) => Ref.update(stderr, (text) => text + chunk)),
          Effect.forkScoped,
        );
        const output = yield* writer.stdout.pipe(
          Stream.decodeText,
          Stream.splitLines,
          Stream.tap((line) =>
            line === "about-to-publish" ? Deferred.succeed(ready, undefined) : Effect.void,
          ),
          Stream.runDrain,
          Effect.forkScoped,
        );
        const writerFailure = (reason: string) =>
          Ref.get(stderr).pipe(
            Effect.flatMap((text) =>
              Effect.fail(new PublishBarrierError({ message: `${reason}: ${text}` })),
            ),
          );
        // The fixture announces this boundary itself, right before the real rename call; killing
        // here lands in the staging-to-publish gap on every run, not "most of the time".
        yield* Deferred.await(ready).pipe(
          Effect.raceFirst(
            writer.exitCode.pipe(
              Effect.matchEffect({
                onFailure: (cause) =>
                  writerFailure(`Writer exited before readiness: ${String(cause)}`),
                onSuccess: (code) => writerFailure(`Writer exited before readiness (${code})`),
              }),
            ),
          ),
          Effect.timeoutOrElse({
            duration: "10 seconds",
            orElse: () => writerFailure("Writer did not reach the publish boundary"),
          }),
        );
        yield* Effect.sync(() => process.kill(Number(writer.pid), "SIGKILL"));
        yield* writer.exitCode.pipe(Effect.ignore);
        yield* Fiber.join(output);
        yield* Fiber.join(diagnostics);

        const target = path.join(root, id, "state.json");
        const raw = yield* fs.readFileString(target);
        const decoded = yield* Schema.decodeEffect(
          Schema.fromJsonString(StackNamespace.SavedStack),
        )(raw);
        // The killed writer never reached the rename: the prior document is untouched, and only
        // its staging file, never a partial target, is left behind.
        expect(decoded).toEqual(savedStack(root, id));
        expect(
          (yield* fs.readDirectory(path.join(root, id))).filter((entry) => entry.endsWith(".tmp")),
        ).toHaveLength(1);

        yield* state.save({
          ...decoded,
          identity: { ...decoded.identity, stackName: "recovered" },
        });
        expect(yield* state.read(id)).toEqual({
          ...decoded,
          identity: { ...decoded.identity, stackName: "recovered" },
        });
      }),
    ).pipe(Effect.provide(testLayer)),
  20_000,
);

it.live(
  "serializes real writer processes and releases a killed registry holder while its child survives",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "namespace-e2e-lock-process-" });
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const spawn = (args: ReadonlyArray<string>) =>
          spawner.spawn(
            ChildProcess.make(process.execPath, [lockFixture, ...args], {
              stdin: "ignore",
              stdout: "pipe",
              stderr: "pipe",
              detached: true,
              forceKillAfter: "1 second",
            }),
          );
        const readOutput = (child: ChildProcessSpawner.ChildProcessHandle) =>
          Effect.all(
            [
              child.stdout.pipe(Stream.decodeText, Stream.mkString),
              child.stderr.pipe(Stream.decodeText, Stream.mkString),
              child.exitCode,
            ],
            { concurrency: "unbounded" },
          );

        const state = yield* makeTestState(root);
        const saved = savedStack(root, "stack-main");
        yield* state.save(saved);

        yield* Effect.forEach(
          ["first", "second", "third"],
          (id) =>
            Effect.scoped(
              Effect.gen(function* () {
                const writer = yield* spawn(["write", root, id]);
                const [, stderr, code] = yield* readOutput(writer);
                expect(code, stderr).toBe(0);
              }),
            ),
          { concurrency: "unbounded" },
        );
        expect((yield* state.read(saved.id))?.instances.map(({ id }) => id).sort()).toEqual([
          "first",
          "second",
          "third",
        ]);

        const holder = yield* spawn(["hold", root]);
        const locked = yield* Deferred.make<void>();
        const childReady = yield* Deferred.make<string>();
        const stderr = yield* Ref.make("");
        const diagnostics = yield* holder.stderr.pipe(
          Stream.decodeText,
          Stream.runForEach((chunk) => Ref.update(stderr, (text) => text + chunk)),
          Effect.forkScoped,
        );
        const output = yield* holder.stdout.pipe(
          Stream.decodeText,
          Stream.splitLines,
          Stream.runForEach((line) =>
            line === "locked"
              ? Deferred.succeed(locked, undefined).pipe(Effect.asVoid)
              : line.startsWith("child:")
                ? Deferred.succeed(childReady, line.slice(6)).pipe(Effect.asVoid)
                : Effect.void,
          ),
          Effect.forkScoped,
        );
        const holderFailure = (reason: string) =>
          Ref.get(stderr).pipe(
            Effect.flatMap((text) =>
              Effect.fail(new LockFixtureError({ message: `${reason}: ${text}` })),
            ),
          );
        yield* Effect.all([Deferred.await(locked), Deferred.await(childReady)]).pipe(
          Effect.raceFirst(
            holder.exitCode.pipe(
              Effect.matchEffect({
                onFailure: (cause) =>
                  holderFailure(`Holder exited before readiness: ${String(cause)}`),
                onSuccess: (code) => holderFailure(`Holder exited before readiness (${code})`),
              }),
            ),
          ),
          Effect.timeoutOrElse({
            duration: "10 seconds",
            orElse: () => holderFailure("Holder readiness timed out"),
          }),
        );
        const childPid = yield* Schema.decodeEffect(Schema.FiniteFromString)(
          yield* Deferred.await(childReady),
        );
        const kill = (pid: number) =>
          Effect.try({
            try: () => process.kill(pid, "SIGKILL"),
            catch: (cause) => new LockFixtureError({ message: String(cause) }),
          });
        yield* Effect.addFinalizer(() =>
          kill(childPid).pipe(
            Effect.ignore,
            Effect.andThen(Fiber.join(output)),
            Effect.andThen(Fiber.join(diagnostics)),
            Effect.andThen(waitForOwnerExit(childPid, ownerExitProbe(fs)).pipe(Effect.ignore)),
            Effect.timeout("10 seconds"),
            Effect.orDie,
          ),
        );
        yield* kill(Number(holder.pid));
        yield* holder.exitCode.pipe(Effect.exit);
        yield* state.withLock(
          state.save({ ...saved, identity: { ...saved.identity, stackName: "after-crash" } }),
        );
        expect((yield* state.read(saved.id))?.identity.stackName).toBe("after-crash");
        yield* Effect.try({
          try: () => process.kill(childPid, 0),
          catch: (cause) =>
            new LockFixtureError({
              message: `Child did not survive the killed holder: ${String(cause)}`,
            }),
        });
      }),
    ).pipe(Effect.provide(testLayer)),
  20_000,
);

const docker = Effect.fn("Namespace.e2e.docker")((args: ReadonlyArray<string>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const child = yield* spawner.spawn(
        ChildProcess.make("docker", args, { stdin: "ignore", stdout: "pipe", stderr: "pipe" }),
      );
      const [stdout, stderr, code] = yield* Effect.all(
        [
          Stream.mkString(Stream.decodeText(child.stdout)),
          Stream.mkString(Stream.decodeText(child.stderr)),
          child.exitCode,
        ],
        { concurrency: "unbounded" },
      );
      if (Number(code) !== 0)
        return yield* Effect.die(`docker ${args.join(" ")} failed: ${stderr}`);
      return stdout.trim();
    }),
  ),
);

// Needs a real Docker daemon, which only the Linux CI runner has.
it.live.skipIf(process.platform === "win32" || process.platform === "darwin")(
  "removes exactly the containers a SIGKILLed owner's claims recorded, with no manual cleanup",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "namespace-e2e-container-" });
        const stateRoot = `${root}/state`;
        const cacheRoot = `${root}/cache`;
        const stack = yield* create({
          projectRoot: root,
          stateRoot,
          cacheRoot,
          runtime: "docker",
          startOwner: true,
        });
        yield* Effect.addFinalizer(() => stack.destroy.pipe(Effect.ignore));
        const mail = yield* stack.services.create({ service: "mail", config: {} });
        yield* mail.start;
        yield* mail.ready;

        const containerIds = (yield* docker([
          "ps",
          "--all",
          "--quiet",
          "--no-trunc",
          "--filter",
          `label=com.supabase.stack=${stack.id}`,
          "--filter",
          `label=com.supabase.instance=${mail.id}`,
        ]))
          .split("\n")
          .filter((id) => id.length > 0);
        expect(containerIds).toHaveLength(1);
        const [containerId] = containerIds;

        const ownerPid = yield* captureOwnerPid({ stateRoot, cacheRoot }, stack.id);
        const released = yield* watchLeaseRelease(stateRoot, stack.id);
        yield* Effect.sync(() => process.kill(ownerPid, "SIGKILL"));
        yield* released;

        // Killing the owner leaves the container running; nothing in this test removes it.
        expect(
          yield* docker(["inspect", "--format", "{{.State.Status}}", String(containerId)]),
        ).not.toBe("");

        const reopened = yield* open({
          id: stack.id,
          stateRoot,
          cacheRoot,
          startOwner: true,
        });
        yield* Effect.addFinalizer(() => reopened.destroy.pipe(Effect.ignore));

        const remaining = yield* docker([
          "ps",
          "--all",
          "--quiet",
          "--no-trunc",
          "--filter",
          `label=com.supabase.stack=${stack.id}`,
        ]);
        expect(remaining).toBe("");
        const inspectExit = yield* docker([
          "inspect",
          "--format",
          "{{.State.Status}}",
          String(containerId),
        ]).pipe(Effect.exit);
        expect(inspectExit._tag).toBe("Failure");
      }),
    ).pipe(Effect.provide(testLayer)),
  120_000,
);
