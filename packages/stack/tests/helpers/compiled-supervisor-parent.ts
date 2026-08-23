// oxlint-disable effecttsgo/new-promise, effecttsgo/process-env -- Tests intentionally exercise native async, HTTP, timer, and subprocess boundaries.
import { Context, Effect, Layer, Schema } from "effect";
import { runTestSupervisor } from "./supervisor-child.ts";
import { Stack } from "../../src/Stack.ts";
import { httpTransportClientLayer } from "../../src/HttpTransportClient.ts";
import { SupervisorStartCommandSchema } from "../../src/SupervisorProtocol.ts";
import { daemonEntryPoint } from "../../src/platform-bun.ts";
import { supervisorLayer } from "../../src/supervisor.ts";

/**
 * The compiled parent and its re-entered child exchange only schema-validated
 * values. The child itself uses the supervisor's production protocol; this
 * event only tells the test process that the parent obtained its RemoteStack
 * layer and detached the compiled supervisor child.
 */
export const CompiledSupervisorParentEventSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal("ready"), stackId: Schema.String }),
  Schema.Struct({ type: Schema.Literal("error"), message: Schema.String }),
]);

type ParentEvent = typeof CompiledSupervisorParentEventSchema.Type;

const send = (event: ParentEvent): Promise<void> =>
  new Promise((resolve, reject) => {
    if (process.send === undefined || !process.connected) {
      reject(new Error("compiled supervisor parent IPC is unavailable"));
      return;
    }
    try {
      process.send(Schema.encodeSync(CompiledSupervisorParentEventSchema)(event), (cause) => {
        if (cause === null) resolve();
        else reject(cause);
      });
    } catch (cause) {
      reject(cause);
    }
  });

const fail = (cause: unknown): void => {
  const message = cause instanceof Error ? cause.message : String(cause);
  void send({ type: "error", message }).finally(() => process.disconnect?.());
};

const runParent = (raw: unknown): void => {
  const program = Effect.scoped(
    Effect.gen(function* () {
      const input = yield* Schema.decodeUnknownEffect(SupervisorStartCommandSchema)(raw);
      const remoteLayer = yield* supervisorLayer(input, daemonEntryPoint).pipe(
        Effect.provide(httpTransportClientLayer),
      );
      const context = yield* Layer.build(remoteLayer);
      // Force the generated RemoteStack layer to be materialized before
      // reporting readiness; this is the real parent/child detach boundary.
      Context.get(context, Stack);
      yield* Effect.promise(() => send({ type: "ready", stackId: input.stackId }));
    }),
  );
  void Effect.runPromise(program)
    .then(() => process.disconnect?.())
    .catch(fail);
};

const onMessage = (raw: unknown): void => runParent(raw);

if (import.meta.main) {
  if (process.env["SUPABASE_STACK_RUN_DAEMON"] === "1") {
    // The compiled child re-enters this same artifact with the stable marker
    // installed by forkSupervisor. It receives the supervisor start command on
    // the inherited IPC channel and executes the test runtime platform.
    runTestSupervisor();
  } else {
    process.once("message", onMessage);
  }
}

export type CompiledSupervisorStartMessage = typeof SupervisorStartCommandSchema.Type;
