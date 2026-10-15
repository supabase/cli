import { Effect, Option } from "effect";

import { RemoteTarget } from "../config/remote-target.service.ts";
import { remoteTargetRuntimeLayer } from "./management-api-runtime.layer.ts";
import { softProjectStateMode } from "./project-state-mode.ts";

const noEnv: Record<string, string> = {};

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

const linkedEnv = Effect.map(loadTarget(Option.none()), (target) => ({
  SUPABASE_PROJECT_ID: target.ref,
}));

/**
 * Env that hands a Go-delegated command with no `--project-ref` flag its linked ref, since stack
 * mode keeps no `.temp/project-ref` for the Go binary to read. Go reads `SUPABASE_PROJECT_ID` as
 * its local `project_id` too, so Docker resource names follow the ref. The target runtime is
 * built only in stack mode, so legacy mode loads no profile and reads no link.
 */
export const goStandaloneLinkedTargetEnv = Effect.fn("GoProxy.standaloneLinkedTargetEnv")(
  function* () {
    if ((yield* softProjectStateMode) !== "stack") return noEnv;
    return yield* linkedEnv.pipe(Effect.provide(remoteTargetRuntimeLayer));
  },
);

/**
 * The `--project-ref` argument for a Go-delegated command that accepts one: stack mode resolves
 * the ref in TypeScript and passes it explicitly; legacy mode forwards only the flag the user
 * typed and never builds the target runtime.
 */
export const goProjectRefArgs = Effect.fn("GoProxy.projectRefArgs")(function* (
  projectRef: Option.Option<string>,
) {
  if ((yield* softProjectStateMode) !== "stack") {
    return Option.isSome(projectRef) ? ["--project-ref", projectRef.value] : [];
  }
  const target = yield* loadTarget(projectRef).pipe(Effect.provide(remoteTargetRuntimeLayer));
  return ["--project-ref", target.ref];
});
