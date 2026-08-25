import { Predicate } from "effect";
import type { RestartPolicy } from "./ServiceDef.ts";
import type { ServiceDesiredState } from "./ServiceState.ts";

export type LifecycleCause =
  | { readonly _tag: "ProcessExit"; readonly exitCode: number }
  | { readonly _tag: "Unhealthy" };

export type RestartDecision =
  | { readonly _tag: "Restart"; readonly restartCount: number }
  | {
      readonly _tag: "Terminate";
      readonly reason: "NotDesired" | "PolicyDisabled" | "BudgetExhausted";
    }
  | { readonly _tag: "KeepRunningUnhealthy" };

export const UNHEALTHY_RESTART_EXHAUSTED_ERROR =
  "Health check failed and restart budget was exhausted";

export function decideRestart(options: {
  readonly cause: LifecycleCause;
  readonly policy: RestartPolicy;
  readonly restartCount: number;
  readonly maxRestarts: number;
  readonly desired: ServiceDesiredState;
}): RestartDecision {
  const causeIsUnhealthy = Predicate.isTagged(options.cause, "Unhealthy");
  const processExit = Predicate.isTagged(options.cause, "ProcessExit") ? options.cause : undefined;

  if (options.desired !== "running") {
    return { _tag: "Terminate", reason: "NotDesired" };
  }

  if (causeIsUnhealthy && options.policy === "no") {
    return { _tag: "KeepRunningUnhealthy" };
  }

  const policyAllowsRestart =
    options.policy === "always" ||
    options.policy === "unless-stopped" ||
    (options.policy === "on-failure" &&
      (causeIsUnhealthy || (processExit !== undefined && processExit.exitCode !== 0)));

  if (!policyAllowsRestart) {
    return { _tag: "Terminate", reason: "PolicyDisabled" };
  }

  if (options.maxRestarts !== 0 && options.restartCount >= options.maxRestarts) {
    return { _tag: "Terminate", reason: "BudgetExhausted" };
  }

  return { _tag: "Restart", restartCount: options.restartCount + 1 };
}
