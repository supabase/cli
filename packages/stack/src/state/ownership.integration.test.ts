import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Option,
  Path,
  Ref,
  Schema,
  Stream,
} from "effect";
import { ChildProcess } from "effect/unstable/process";
import { createServer, type Server } from "node:net";
import { deriveStackId, type StackIdentity } from "../identity/Identity.ts";
import { StackOwnershipConflictError, StackStateInvalidError } from "../public/Errors.ts";
import {
  acquirePortLease,
  acquireOwnership,
  controlEndpointFor,
  installLease,
  LeaseSlotTaken,
  ownerLockExists,
  publishOwnership,
  readOwnerMetadata,
  readOwnerLock,
  writeLockTemp,
  OWNER_LOCK_FORMAT,
  type StackRuntimeEnvironmentValue,
} from "./Ownership.ts";
import { makeStackStateStore, type PersistedStackState } from "./StackStateStore.ts";
import { resolveStackPaths } from "./Paths.ts";

const bindEphemeral = Effect.callback<Server, Error>((resume) => {
  const server = createServer((socket) => socket.destroy());
  const onError = (error: Error) => {
    server.off("listening", onListening);
    resume(Effect.fail(error));
  };
  const onListening = () => {
    server.off("error", onError);
    resume(Effect.succeed(server));
  };
  server.once("error", onError);
  server.once("listening", onListening);
  server.listen({ host: "127.0.0.1", port: 0 });
  return Effect.sync(() => {
    server.off("error", onError);
    server.off("listening", onListening);
    if (server.listening) server.close(() => undefined);
  });
});

const closeServer = (server: Server) =>
  Effect.callback<void, Error>((resume) => {
    if (!server.listening) {
      resume(Effect.void);
      return;
    }
    server.close((error) =>
      error === undefined ? resume(Effect.void) : resume(Effect.fail(error)),
    );
  });

const jsonText = (value: unknown) =>
  Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))(value);

const withPlatform = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(effect).pipe(Effect.provide(NodeServices.layer));

const identity: StackIdentity = {
  projectRoot: "/tmp/project",
  checkoutRoot: "/tmp/project",
  workspaceId: "/tmp/project",
  checkoutId: "/tmp/project",
  branchContext: "ordinary-workspace",
  localProjectKey: ".",
  stackName: "default",
};

const stateFor = (stackId: string): PersistedStackState => ({
  format: "supabase-stack-state-v1",
  identity: { ...identity, stackId },
  runtime: { kind: "native" },
  desiredLifecycle: "unconfigured",
  ports: [],
  privatePorts: [],
  secrets: {},
});

const errorOf = <E>(exit: Exit.Exit<unknown, E>): E | undefined =>
  Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined;

describe("stack ownership", () => {
  it.live("releases an exact port after a competing lease bind fails", () =>
    withPlatform(
      Effect.gen(function* () {
        const blocker = yield* bindEphemeral;
        const address = blocker.address();
        if (typeof address !== "object" || address === null)
          return yield* Effect.die("Blocker did not expose a bound port");
        const failed = yield* acquirePortLease(address.port).pipe(Effect.exit);
        expect(Exit.isFailure(failed)).toBe(true);
        yield* closeServer(blocker);
        const lease = yield* acquirePortLease(address.port);
        yield* lease.close;
      }),
    ),
  );

  it.live("initializes one complete state for concurrent equivalent creators", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-stack-init-" });
        const stackId = yield* deriveStackId(identity);
        const store = yield* makeStackStateStore({ stateRoot: root });
        const candidate = stateFor(stackId);
        const [first, second] = yield* Effect.all(
          [store.initialize(stackId, candidate), store.initialize(stackId, candidate)],
          { concurrency: 2 },
        );
        expect(first).toEqual(candidate);
        expect(second).toEqual(candidate);
        expect(yield* store.read(stackId)).toEqual(candidate);
      }),
    ),
  );

  it.live("publishes and releases an exact session-fenced owner", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-stack-owner-" });
        const stackId = yield* deriveStackId(identity);
        const environment: StackRuntimeEnvironmentValue = {
          stateRoot: root,
          tempRoot: root,
          platform: "posix",
        };
        const lease = yield* acquireOwnership({
          stateRoot: root,
          stackId,
          ownerSessionId: "session-one",
          rpcRelease: "stack-rpc-v1@0.1.0",
          environment,
        });
        expect(yield* ownerLockExists(root, stackId)).toBe(true);
        expect(lease.metadata.endpoint).toEqual(controlEndpointFor(stackId, environment));
        yield* publishOwnership(lease);
        expect(yield* readOwnerMetadata(root, stackId, environment)).toEqual(lease.metadata);

        const competing = yield* acquireOwnership({
          stateRoot: root,
          stackId,
          ownerSessionId: "session-two",
          rpcRelease: "stack-rpc-v1@0.1.0",
          environment,
        }).pipe(Effect.exit);
        expect(errorOf(competing)).toBeInstanceOf(StackOwnershipConflictError);
        yield* lease.release;
        expect(yield* ownerLockExists(root, stackId)).toBe(false);
        expect(yield* readOwnerMetadata(root, stackId, environment)).toBeUndefined();
        const after = yield* acquireOwnership({
          stateRoot: root,
          stackId,
          ownerSessionId: "session-three",
          rpcRelease: "stack-rpc-v1@0.1.0",
          environment,
        });
        yield* after.release;
      }),
    ),
  );

  it.live("recovers an owner lease after an exact supervisor SIGKILL", () =>
    withPlatform(
      Effect.gen(function* () {
        if (process.platform === "win32") return yield* Effect.void;
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-stack-crash-" });
        const childIdentity = {
          ...identity,
          projectRoot: root,
          checkoutRoot: root,
          workspaceId: root,
          checkoutId: root,
          localProjectKey: ".",
        };
        const stackId = yield* deriveStackId(childIdentity);
        const environment: StackRuntimeEnvironmentValue = {
          stateRoot: root,
          tempRoot: root,
          platform: "posix",
        };
        const moduleUrl = new URL("./Ownership.ts", import.meta.url).href;
        const script = `
          const { Effect } = await import("effect");
          const { NodeServices } = await import("@effect/platform-node");
          const { acquireOwnership, publishOwnership } = await import(process.env.OWNERSHIP_MODULE);
          const environment = JSON.parse(process.env.OWNERSHIP_ENVIRONMENT);
          const lease = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
            const value = yield* acquireOwnership({
              stateRoot: environment.stateRoot,
              stackId: process.env.OWNERSHIP_STACK_ID,
              ownerSessionId: "crashed-owner",
              rpcRelease: "stack-rpc-v1@0.1.0",
              environment,
            });
            yield* publishOwnership(value);
            process.stdout.write("READY\\n");
            yield* Effect.never;
          }).pipe(Effect.provide(NodeServices.layer))));
          void lease;
        `;
        const child = yield* ChildProcess.make(
          process.execPath,
          ["--input-type=module", "-e", script],
          {
            cwd: process.cwd(),
            env: {
              OWNERSHIP_MODULE: moduleUrl,
              OWNERSHIP_STACK_ID: stackId,
              OWNERSHIP_ENVIRONMENT: jsonText(environment),
            },
            extendEnv: true,
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        const ready = yield* Deferred.make<void>();
        const stderrText = yield* Ref.make<ReadonlyArray<string>>([]);
        const childExitCode = yield* Ref.make<Option.Option<number>>(Option.none());
        const output = yield* child.stdout.pipe(
          Stream.decodeText,
          Stream.splitLines,
          Stream.runForEach((line) =>
            line === "READY" ? Deferred.succeed(ready, undefined).pipe(Effect.asVoid) : Effect.void,
          ),
          Effect.forkChild({ startImmediately: true }),
        );
        const stderr = yield* child.stderr.pipe(
          Stream.decodeText,
          Stream.splitLines,
          Stream.runForEach((line) => Ref.update(stderrText, (lines) => [...lines, line])),
          Effect.forkChild({ startImmediately: true }),
        );
        const exitWatcher = yield* child.exitCode.pipe(
          Effect.flatMap((code) => Ref.set(childExitCode, Option.some(code))),
          Effect.forkChild({ startImmediately: true }),
        );
        try {
          yield* Deferred.await(ready).pipe(
            Effect.timeoutOrElse({
              duration: "15 seconds",
              orElse: () =>
                Effect.gen(function* () {
                  const lines = yield* Ref.get(stderrText);
                  const exitCode = yield* Ref.get(childExitCode);
                  const state = Option.isSome(exitCode)
                    ? ` (exit code ${String(exitCode.value)})`
                    : "";
                  return yield* new StackStateInvalidError({
                    message: `owner child did not become ready${state}${lines.length === 0 ? "" : `: ${lines.join("\\n")}`}`,
                  });
                }),
            }),
          );
          expect(yield* ownerLockExists(root, stackId)).toBe(true);
          const metadata = yield* readOwnerMetadata(root, stackId, environment);
          expect(metadata?.ownerSessionId).toBe("crashed-owner");
          yield* child.kill({ killSignal: "SIGKILL" });
          yield* child.exitCode.pipe(Effect.ignore);
          const successor = yield* acquireOwnership({
            stateRoot: root,
            stackId,
            ownerSessionId: "successor-owner",
            rpcRelease: "stack-rpc-v1@0.1.0",
            environment,
          });
          expect(successor.metadata.endpoint).toEqual(controlEndpointFor(stackId, environment));
          expect(yield* ownerLockExists(root, stackId)).toBe(true);
          yield* publishOwnership(successor);
          expect((yield* readOwnerMetadata(root, stackId, environment))?.ownerSessionId).toBe(
            "successor-owner",
          );
          yield* successor.release;
          expect(yield* ownerLockExists(root, stackId)).toBe(false);
          expect(yield* readOwnerMetadata(root, stackId, environment)).toBeUndefined();
        } finally {
          yield* child.kill({ killSignal: "SIGKILL" }).pipe(Effect.ignore);
          yield* Fiber.interrupt(output);
          yield* Fiber.interrupt(stderr);
          yield* Fiber.interrupt(exitWatcher);
        }
      }),
    ),
  );

  it.live("fails closed when owner metadata belongs to another identity", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-stack-fence-" });
        const stackId = yield* deriveStackId(identity);
        const environment: StackRuntimeEnvironmentValue = {
          stateRoot: root,
          tempRoot: root,
          platform: "posix",
        };
        const lease = yield* acquireOwnership({
          stateRoot: root,
          stackId,
          ownerSessionId: "session-one",
          rpcRelease: "stack-rpc-v1@0.1.0",
          environment,
        });
        yield* publishOwnership(lease);
        const metadataPath = lease.metadataPath;
        const text = yield* fs.readFileString(metadataPath);
        yield* fs.writeFileString(metadataPath, text.replace(stackId, "b".repeat(64)));
        const read = yield* readOwnerMetadata(root, stackId, environment).pipe(Effect.exit);
        expect(errorOf(read)).toBeInstanceOf(StackStateInvalidError);
        yield* lease.release;
        // A malformed replacement cannot be removed by this stale finalizer.
        expect(yield* fs.exists(metadataPath)).toBe(true);
      }),
    ),
  );

  it.live("reclaims a valid owner lock after its lease is released", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-stack-reclaim-" });
        const stackId = yield* deriveStackId(identity);
        const environment: StackRuntimeEnvironmentValue = {
          stateRoot: root,
          tempRoot: root,
          platform: "posix",
        };
        const paths = yield* resolveStackPaths({ stateRoot: root, stackId });
        yield* fs.makeDirectory(paths.runtime, { recursive: true });
        const stale = yield* bindEphemeral;
        const address = stale.address();
        if (address === null || typeof address === "string")
          return yield* new StackStateInvalidError({ message: "missing lease port" });
        const staleEndpoint = controlEndpointFor(stackId, environment);
        if (staleEndpoint.kind !== "unix")
          return yield* new StackStateInvalidError({ message: "expected unix endpoint" });
        yield* fs.writeFileString(
          path.join(paths.runtime, "owner.lock"),
          jsonText({
            format: "supabase-stack-lease-v1",
            token: "old-session",
            port: address.port,
          }),
        );
        yield* fs.writeFileString(
          paths.controlMetadata,
          jsonText({
            format: "supabase-stack-owner-v1",
            stackId,
            ownerSessionId: "old-session",
            endpoint: staleEndpoint,
            rpcRelease: "stack-rpc-v1@0.1.0",
          }),
        );
        yield* fs.writeFileString(staleEndpoint.path, "stale socket");
        yield* closeServer(stale);
        const lease = yield* acquireOwnership({
          stateRoot: root,
          stackId,
          ownerSessionId: "new-session",
          rpcRelease: "stack-rpc-v1@0.1.0",
          environment,
        });
        expect(lease.metadata.ownerSessionId).toBe("new-session");
        expect(yield* fs.exists(paths.controlMetadata)).toBe(false);
        expect(yield* fs.exists(staleEndpoint.path)).toBe(false);
        yield* lease.release;
      }),
    ),
  );

  it.live("serializes concurrent recovery contenders", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-stack-race-" });
        const stackId = yield* deriveStackId(identity);
        const environment: StackRuntimeEnvironmentValue = {
          stateRoot: root,
          tempRoot: root,
          platform: "posix",
        };
        const paths = yield* resolveStackPaths({ stateRoot: root, stackId });
        yield* fs.makeDirectory(paths.runtime, { recursive: true });
        const stale = yield* bindEphemeral;
        const address = stale.address();
        if (address === null || typeof address === "string")
          return yield* new StackStateInvalidError({ message: "missing lease port" });
        yield* fs.writeFileString(
          path.join(paths.runtime, "owner.lock"),
          jsonText({ format: "supabase-stack-lease-v1", token: "old", port: address.port }),
        );
        yield* closeServer(stale);
        const attempts = yield* Effect.all(
          ["one", "two"].map((ownerSessionId) =>
            acquireOwnership({
              stateRoot: root,
              stackId,
              ownerSessionId,
              rpcRelease: "rpc",
              environment,
            }).pipe(Effect.exit),
          ),
          { concurrency: 2 },
        );
        const successes = attempts.filter(Exit.isSuccess);
        expect(successes).toHaveLength(1);
        expect(
          attempts
            .filter(Exit.isFailure)
            .map(errorOf)
            .some((error) => error instanceof StackOwnershipConflictError),
        ).toBe(true);
        if (successes[0] !== undefined) yield* successes[0].value.release;
      }),
    ),
  );

  it.live("fails closed for a malformed owner lock", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-stack-malformed-" });
        const stackId = yield* deriveStackId(identity);
        const environment: StackRuntimeEnvironmentValue = {
          stateRoot: root,
          tempRoot: root,
          platform: "posix",
        };
        const paths = yield* resolveStackPaths({ stateRoot: root, stackId });
        yield* fs.makeDirectory(paths.runtime, { recursive: true });
        yield* fs.writeFileString(path.join(paths.runtime, "owner.lock"), "not-json");
        const result = yield* acquireOwnership({
          stateRoot: root,
          stackId,
          ownerSessionId: "new",
          rpcRelease: "rpc",
          environment,
        }).pipe(Effect.exit);
        expect(errorOf(result)).toBeInstanceOf(StackStateInvalidError);
      }),
    ),
  );

  it.live("fails closed when metadata exists without an owner lock", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-stack-metadata-only-" });
        const stackId = yield* deriveStackId(identity);
        const environment: StackRuntimeEnvironmentValue = {
          stateRoot: root,
          tempRoot: root,
          platform: "posix",
        };
        const paths = yield* resolveStackPaths({ stateRoot: root, stackId });
        yield* fs.makeDirectory(paths.runtime, { recursive: true });
        const metadata = {
          format: "supabase-stack-owner-v1",
          stackId,
          ownerSessionId: "orphaned-owner",
          endpoint: controlEndpointFor(stackId, environment),
          rpcRelease: "rpc",
        };
        yield* fs.writeFileString(paths.controlMetadata, jsonText(metadata));
        const result = yield* acquireOwnership({
          stateRoot: root,
          stackId,
          ownerSessionId: "new-owner",
          rpcRelease: "rpc",
          environment,
        }).pipe(Effect.exit);
        expect(errorOf(result)).toBeInstanceOf(StackOwnershipConflictError);
        expect(yield* fs.readFileString(paths.controlMetadata)).toBe(jsonText(metadata));
        expect(yield* fs.exists(paths.runtime + "/owner.lock")).toBe(false);
      }),
    ),
  );

  it.live("does not replace a fresh lock installed after stale observation", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-stack-race-install-" });
        const stackId = yield* deriveStackId(identity);
        const paths = yield* resolveStackPaths({ stateRoot: root, stackId });
        yield* fs.makeDirectory(paths.runtime, { recursive: true });
        const old = { format: OWNER_LOCK_FORMAT, token: "old", port: 45_001 } as const;
        const fresh = { format: OWNER_LOCK_FORMAT, token: "fresh", port: 45_002 } as const;
        const lockPath = path.join(paths.runtime, "owner.lock");
        yield* fs.writeFileString(lockPath, jsonText(old));
        const temporary = yield* writeLockTemp(fs, path, lockPath, {
          format: OWNER_LOCK_FORMAT,
          token: "candidate",
          port: 45_003,
        });
        yield* fs.writeFileString(lockPath, jsonText(fresh));
        const result = yield* installLease({ fs, lockPath, temporary, observed: old }).pipe(
          Effect.exit,
        );
        expect(errorOf(result)).toBeInstanceOf(LeaseSlotTaken);
        expect(yield* readOwnerLock(fs, lockPath)).toEqual(fresh);
        yield* fs.remove(temporary, { force: true });
      }),
    ),
  );
});
