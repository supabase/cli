import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Crypto, Data, Effect, FileSystem, Path, Schema } from "effect";
// Node's fd3 readiness channel has no FileSystem abstraction, so it's used directly here.
// oxlint-disable-next-line effecttsgo/node-builtin-import -- readiness uses inherited fd3 directly, which has no FileSystem service abstraction.
import * as NodeFs from "node:fs";
import {
  acquireOwnership,
  publishOwnership,
  type StackRuntimeEnvironmentValue,
} from "../state/Ownership.ts";
import { makeStackStateStore } from "../state/StackStateStore.ts";
import { makeSupervisor } from "../supervisor/Supervisor.ts";
import { makeProductionRuntime } from "../runtime/ProductionRuntime.ts";
import { startControlServer } from "../control/ControlServer.ts";
import { STACK_RPC_RELEASE } from "../control/StackRpc.ts";
import { StackOwnershipConflictError } from "../public/Errors.ts";
import {
  SupervisorArgsSchema,
  SupervisorReadySchema,
  type SupervisorArgs,
} from "../supervisor/LaunchProtocol.ts";
import { openSupervisorBootstrapLog } from "../supervisor/BootstrapLog.ts";

class SupervisorReadinessError extends Data.TaggedError("SupervisorReadinessError")<{
  readonly message: string;
  readonly cause?: unknown;
  readonly phase: "encode" | "write";
}> {}

interface ReadinessState {
  written: boolean;
}

const reportSupervisorFailure = (error: unknown, readiness: ReadinessState): void => {
  if (!readiness.written)
    try {
      const conflict = error instanceof StackOwnershipConflictError;
      // The descriptor is owned by the parent launcher, written directly at this process
      // boundary.
      NodeFs.writeSync(
        3,
        `${Schema.encodeSync(Schema.fromJsonString(SupervisorReadySchema))({ ok: false, code: conflict ? "ownership-conflict" : "failed", message: error instanceof Error ? error.message : "Supervisor failed" })}\n`,
      );
      NodeFs.closeSync(3);
    } catch {
      // The parent may have already closed the readiness descriptor.
    }
  process.exitCode = 1;
};

const writeReadiness = (
  value: Schema.Schema.Type<typeof SupervisorReadySchema>,
  readiness: ReadinessState,
): Effect.Effect<void, SupervisorReadinessError> =>
  Effect.gen(function* () {
    const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(SupervisorReadySchema))(
      value,
    ).pipe(
      Effect.mapError(
        (cause) =>
          new SupervisorReadinessError({
            message: "Unable to encode supervisor readiness",
            cause,
            phase: "encode",
          }),
      ),
    );
    yield* Effect.try({
      try: () => {
        try {
          NodeFs.writeSync(3, `${encoded}\n`, undefined, "utf8");
          readiness.written = true;
        } finally {
          try {
            NodeFs.closeSync(3);
          } catch {
            // The launcher may have already closed the readiness descriptor.
          }
        }
      },
      catch: (cause) =>
        new SupervisorReadinessError({
          message: "Unable to write supervisor readiness",
          cause,
          phase: "write",
        }),
    });
  });

const runSupervisor = (args: SupervisorArgs, readiness: ReadinessState) =>
  Effect.scoped(
    Effect.gen(function* () {
      const environment: StackRuntimeEnvironmentValue = {
        stateRoot: args.stateRoot,
        ...(args.artifactCacheRoot === undefined
          ? {}
          : { artifactCacheRoot: args.artifactCacheRoot }),
        tempRoot: args.tempRoot,
        platform: args.platform,
      };
      const store = yield* makeStackStateStore({ stateRoot: args.stateRoot });
      const ownerSessionId = args.ownerSessionId;
      const lease = yield* acquireOwnership({
        stateRoot: args.stateRoot,
        stackId: args.stackId,
        ownerSessionId,
        rpcRelease: STACK_RPC_RELEASE,
        environment,
      });
      const context = yield* Effect.context<FileSystem.FileSystem | Path.Path | Crypto.Crypto>();
      const runtime = yield* makeProductionRuntime({
        stateRoot: args.stateRoot,
        ...(args.artifactCacheRoot === undefined
          ? {}
          : { artifactCacheRoot: args.artifactCacheRoot }),
        stackId: args.stackId,
        ownerSessionId,
        stateStore: store,
        context,
      });
      const supervisor = yield* makeSupervisor({
        stackId: args.stackId,
        ownerSessionId,
        stateStore: store,
        context,
        runtime,
      });
      yield* startControlServer({
        endpoint: lease.metadata.endpoint,
        stackId: args.stackId,
        ownerSessionId,
        rpcRelease: STACK_RPC_RELEASE,
        maintenanceHandlers: supervisor.maintenanceHandlers,
        rpcHandlers: supervisor.rpcHandlers,
        onShutdownReady: supervisor.shutdownIfIdle,
        onRpcPreface: () => supervisor.acquireRpcPreface,
      });
      yield* publishOwnership(lease);
      yield* writeReadiness({ ok: true, stackId: args.stackId, ownerSessionId }, readiness).pipe(
        Effect.catchTag("SupervisorReadinessError", (error) =>
          error.phase === "write" ? Effect.void : Effect.fail(error),
        ),
      );
      yield* supervisor.shutdown;
    }),
  ).pipe(Effect.provide(NodeServices.layer));

const parseSupervisorArgs = (argv: ReadonlyArray<string>) =>
  Schema.decodeEffect(Schema.fromJsonString(SupervisorArgsSchema))(argv[0] ?? "{}");

export const runSupervisorProcess = (argv: ReadonlyArray<string>): Effect.Effect<void> =>
  Effect.suspend(() => {
    const readiness = { written: false } satisfies ReadinessState;
    return parseSupervisorArgs(argv).pipe(
      Effect.tap((args) =>
        Effect.sync(() => {
          const log = openSupervisorBootstrapLog(args.stateRoot, args.stackId);
          if (log === undefined) return;
          const writeChunk = (chunk: string | Uint8Array): void => {
            if (typeof chunk === "string") NodeFs.writeSync(log.fd, chunk);
            else NodeFs.writeSync(log.fd, chunk);
          };
          const hijack = (stream: NodeJS.WriteStream): void => {
            stream.write = ((chunk: unknown, encoding?: unknown, callback?: unknown) => {
              if (typeof chunk === "string" || chunk instanceof Uint8Array) writeChunk(chunk);
              if (typeof encoding === "function") encoding();
              else if (typeof callback === "function") (callback as () => void)();
              return true;
            }) as typeof stream.write;
          };
          hijack(process.stdout);
          hijack(process.stderr);
        }),
      ),
      Effect.flatMap((args) => runSupervisor(args, readiness)),
      Effect.catch((error) => Effect.sync(() => reportSupervisorFailure(error, readiness))),
    );
  });

if (import.meta.main) {
  NodeRuntime.runMain(runSupervisorProcess(process.argv.slice(2)), {
    disableErrorReporting: true,
  });
}
