import { NodeServices } from "@effect/platform-node";
import { Crypto, Data, Effect, FileSystem, Path, Schema } from "effect";
// Node's fd3 readiness channel has no FileSystem abstraction; this is the
// process-entrypoint boundary where the descriptor is intentionally used.
// oxlint-disable-next-line effecttsgo/node-builtin-import
import * as NodeFs from "node:fs";
import {
  acquireOwnership,
  publishOwnership,
  type StackRuntimeEnvironmentValue,
} from "../state/Ownership.ts";
import { makeStackStateStore } from "../state/StackStateStore.ts";
import { makeSupervisor } from "../supervisor/Supervisor.ts";
import { makeProductionRuntimeFactory } from "../runtime/ProductionRuntime.ts";
import { startControlServer } from "../control/ControlServer.ts";
import { STACK_RPC_RELEASE } from "../control/StackRpc.ts";
import { StackOwnershipConflictError } from "../public/Errors.ts";
import {
  SupervisorArgsSchema,
  SupervisorReadySchema,
  type SupervisorArgs,
} from "../supervisor/LaunchProtocol.ts";

class SupervisorReadinessError extends Data.TaggedError("SupervisorReadinessError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const reportSupervisorFailure = (error: unknown): void => {
  try {
    const conflict = error instanceof StackOwnershipConflictError;
    // The descriptor is owned by the parent launcher and intentionally
    // written directly at this standalone process boundary.
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
          }),
      ),
    );
    yield* Effect.try({
      try: () => {
        NodeFs.writeSync(3, `${encoded}\n`, undefined, "utf8");
        NodeFs.closeSync(3);
      },
      catch: (cause) =>
        new SupervisorReadinessError({
          message: "Unable to write supervisor readiness",
          cause,
        }),
    });
  });

const runSupervisor = (args: SupervisorArgs) =>
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
        rpcRelease: args.rpcRelease || STACK_RPC_RELEASE,
        environment,
      });
      const context = yield* Effect.context<FileSystem.FileSystem | Path.Path | Crypto.Crypto>();
      const runtime = yield* makeProductionRuntimeFactory({
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
        rpcRelease: args.rpcRelease || STACK_RPC_RELEASE,
        stateStore: store,
        context,
        runtime,
      });
      yield* startControlServer({
        endpoint: lease.metadata.endpoint,
        stackId: args.stackId,
        ownerSessionId,
        rpcRelease: args.rpcRelease || STACK_RPC_RELEASE,
        maintenanceHandlers: supervisor.maintenanceHandlers,
        rpcHandlers: supervisor.rpcHandlers,
        onShutdownReady: supervisor.shutdownIfIdle,
      });
      yield* publishOwnership(lease);
      yield* writeReadiness({ ok: true, stackId: args.stackId, ownerSessionId });
      yield* supervisor.shutdown;
    }),
  ).pipe(Effect.provide(NodeServices.layer));

const parseSupervisorArgs = (argv: ReadonlyArray<string>) =>
  Schema.decodeEffect(Schema.fromJsonString(SupervisorArgsSchema))(argv[0] ?? "{}");

export const runSupervisorProcess = (argv: ReadonlyArray<string>): Promise<void> =>
  Effect.runPromise(parseSupervisorArgs(argv).pipe(Effect.flatMap(runSupervisor))).catch(
    reportSupervisorFailure,
  );

if (import.meta.main) {
  await runSupervisorProcess(process.argv.slice(2));
}
