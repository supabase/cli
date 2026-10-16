import { Effect, Option } from "effect";

import { RemoteTarget } from "../config/remote-target.service.ts";
import { remoteTargetRuntimeLayer } from "./management-api-runtime.layer.ts";
import { softProjectStateMode } from "./project-state-mode.ts";

const loadTarget = (projectRef: Option.Option<string>) =>
  Effect.gen(function* () {
    const remoteTarget = yield* RemoteTarget;
    const target = yield* remoteTarget.load(projectRef);
    yield* Effect.annotateCurrentSpan({
      "remote_target.source": target.source,
      "project.ref": target.ref,
    });
    return target;
  });

/**
 * The `--project-ref` argument and env for a Go-delegated command that accepts one: stack mode
 * resolves the target in TypeScript and passes its ref explicitly, with the linked pooler URL
 * only when the ref is the linked one; legacy mode forwards only the flag the user typed and
 * never builds the target runtime.
 */
export const goProjectTarget = Effect.fn("GoProxy.projectTarget")(function* (
  projectRef: Option.Option<string>,
) {
  if ((yield* softProjectStateMode) !== "stack") {
    const env: Record<string, string> = {};
    return { args: Option.isSome(projectRef) ? ["--project-ref", projectRef.value] : [], env };
  }
  const target = yield* loadTarget(projectRef).pipe(Effect.provide(remoteTargetRuntimeLayer));
  const env: Record<string, string> = {};
  if (target.poolerUrl !== undefined) env["SUPABASE_INTERNAL_POOLER_URL"] = target.poolerUrl;
  return { args: ["--project-ref", target.ref], env };
});
