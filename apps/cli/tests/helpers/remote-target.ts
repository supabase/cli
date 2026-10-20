import { Effect, Layer, Option } from "effect";

import type {
  InvalidProjectRefError,
  ProjectRefNotLinkedError,
  ProjectRefRequiredError,
} from "../../src/config/project-ref.errors.ts";
import {
  type ParentRefResolution,
  RemoteTarget,
  type RemoteTargetError,
  type ResolvedRemoteTarget,
} from "../../src/config/remote-target.service.ts";

type RefEffect = Effect.Effect<string, RemoteTargetError>;

interface RemoteTargetStubs {
  /** The ref the stub resolves; every other entry point defaults to it. */
  readonly resolve: (flagValue: Option.Option<string>) => RefEffect;
  readonly load?: (flagValue: Option.Option<string>) => RefEffect;
  readonly resolveForLink?: (
    flagValue: Option.Option<string>,
  ) => Effect.Effect<
    string,
    ProjectRefNotLinkedError | InvalidProjectRefError | ProjectRefRequiredError
  >;
  readonly resolveOptional?: (
    flagValue: Option.Option<string>,
  ) => Effect.Effect<Option.Option<string>>;
  readonly prompt?: () => Effect.Effect<string, ProjectRefNotLinkedError>;
}

const targetFor =
  (flagValue: Option.Option<string>) =>
  (ref: string): ResolvedRemoteTarget => ({
    ref,
    source: Option.isSome(flagValue) && flagValue.value.length > 0 ? "flag" : "link",
  });
const noParent: ParentRefResolution = { kind: "absent" };

/** A `RemoteTarget` whose entry points answer with the refs the stubs return. */
export function stubRemoteTarget(stubs: RemoteTargetStubs): Layer.Layer<RemoteTarget> {
  const { resolve } = stubs;
  const load = stubs.load ?? resolve;
  return Layer.succeed(RemoteTarget, {
    resolve: (flagValue) => Effect.map(resolve(flagValue), targetFor(flagValue)),
    load: (flagValue) => Effect.map(load(flagValue), targetFor(flagValue)),
    resolveForLink: (flagValue) =>
      Effect.map(
        stubs.resolveForLink?.(flagValue) ??
          resolve(flagValue).pipe(
            Effect.catch((error) =>
              error._tag === "ProjectRefNotLinkedError" || error._tag === "InvalidProjectRefError"
                ? Effect.fail(error)
                : Effect.die(error),
            ),
          ),
        targetFor(flagValue),
      ),
    resolveOptional: (flagValue) =>
      Effect.map(
        stubs.resolveOptional?.(flagValue) ??
          resolve(flagValue).pipe(
            Effect.map(Option.some),
            Effect.orElseSucceed(() => Option.none<string>()),
          ),
        Option.map(targetFor(flagValue)),
      ),
    prompt: stubs.prompt ?? (() => Effect.orDie(resolve(Option.none()))),
    parent: Effect.succeed(noParent),
    resolveParentScoped: (flagValue) => Effect.map(resolve(flagValue), targetFor(flagValue)),
  });
}
