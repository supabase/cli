import { Context, Effect } from "effect";
import type { Stack } from "./Stack.ts";
import { StackUnavailableError, SupervisorLifecycle } from "./SupervisorLifecycle.ts";

export class RuntimeGate extends Context.Service<
  RuntimeGate,
  {
    readonly stack: Effect.Effect<Stack["Service"], StackUnavailableError>;
  }
>()("stack/RuntimeGate") {
  static make(lifecycle: SupervisorLifecycle["Service"]): RuntimeGate["Service"] {
    return { stack: lifecycle.runtimeStack };
  }
}
