import type { SupabaseApiError } from "@supabase/api/effect";
import { Data, Effect, Option } from "effect";

import { ProjectRefResolver } from "../config/project-ref.service.ts";
import {
  parentNotLinkedMessage,
  parentRefInvalidMessage,
  parentRefTypoHint,
  resolveLinkedParentRef,
  resolveParentScopedProjectRef,
} from "./parent-project-ref.ts";
import { Output } from "../shared/output/output.service.ts";
import { resolveBranchProjectRef } from "./branch-ref.resolver.ts";
import { sanitizeInlineName } from "./http-errors.ts";
import { BRANCH_PROJECT_REF_PATTERN, BRANCH_UUID_PATTERN } from "./ref-patterns.ts";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../shared/telemetry/error-actionability.ts";

/**
 * The resolved comparison/pull target for a command that accepts `--project-ref`
 * (`config diff`, `config pull`, `config push`, `pull`): a project ref, plus the branch
 * name/UUID it was given, if any.
 */
export interface ConfigTarget {
  readonly ref: string;
  readonly branch: string | undefined;
}

/**
 * Builds the four target-resolution failures {@link resolveConfigTarget} can raise.
 * A single type parameter suffices because {@link configTargetErrorsFor} already unions
 * the four minted classes into one type.
 */
export interface ConfigTargetErrors<TError> {
  /**
   * `target` was named as a branch, but no project is linked to search for
   * branches under — none of `SUPABASE_PROJECT_ID`,
   * `supabase/.temp/linked-project.json`, or `supabase/.temp/project-ref`
   * yielded a candidate.
   */
  readonly notLinked: (target: string) => TError;
  /**
   * `target` was named as a branch, and a parent-project candidate exists
   * but is not ref-shaped — corrupt or stale linked state.
   */
  readonly parentRefInvalid: (target: string) => TError;
  /** `target` named a branch the parent project does not have. */
  readonly branchNotFound: (target: string) => TError;
  /** The resolved branch has no project ref yet (still provisioning). */
  readonly branchNotReady: (target: string) => TError;
}

/** The constructor shape every minted target-error class has. */
type ConfigTargetErrorClass<E> = new (args: { readonly message: string }) => E;

/**
 * Mints one calling command family's four target-resolution error classes from its name
 * prefix, keeping `_tag`, fingerprint, and actionability family-owned from one definition.
 *
 * Every caller must re-export each minted class from its own `*.errors.ts` under the
 * family-prefixed name; `error-tag-stability.unit.test.ts`'s static scan only sees the
 * template-interpolated tags there.
 */
export function mintConfigTargetErrors<Prefix extends string>(prefix: Prefix) {
  class BranchNotFoundError extends Data.TaggedError(`${prefix}BranchNotFoundError`)<{
    readonly message: string;
  }> {
    get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
      return actionability.invalidInput;
    }
  }
  class BranchNotLinkedError extends Data.TaggedError(`${prefix}BranchNotLinkedError`)<{
    readonly message: string;
  }> {
    get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
      return actionability.projectNotLinked;
    }
  }
  class ParentRefInvalidError extends Data.TaggedError(`${prefix}ParentRefInvalidError`)<{
    readonly message: string;
  }> {
    get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
      return actionability.relinkProject;
    }
  }
  class BranchNotReadyError extends Data.TaggedError(`${prefix}BranchNotReadyError`)<{
    readonly message: string;
  }> {
    get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
      return { ...actionability.apiStatus, fingerprint_suffix: "branch_not_ready" };
    }
  }
  return { BranchNotFoundError, BranchNotLinkedError, ParentRefInvalidError, BranchNotReadyError };
}

/**
 * Wraps a family's four minted classes as the `errors` bundle {@link resolveConfigTarget}
 * takes. The message text is identical across every family, so it lives here instead of
 * being restated per handler.
 */
export function configTargetErrorsFor<
  TNotLinked,
  TParentRefInvalid,
  TBranchNotFound,
  TBranchNotReady,
>(classes: {
  readonly notLinked: ConfigTargetErrorClass<TNotLinked>;
  readonly parentRefInvalid: ConfigTargetErrorClass<TParentRefInvalid>;
  readonly branchNotFound: ConfigTargetErrorClass<TBranchNotFound>;
  readonly branchNotReady: ConfigTargetErrorClass<TBranchNotReady>;
}): ConfigTargetErrors<TNotLinked | TParentRefInvalid | TBranchNotFound | TBranchNotReady> {
  return {
    notLinked: (target) => new classes.notLinked({ message: parentNotLinkedMessage(target) }),
    parentRefInvalid: (target) =>
      new classes.parentRefInvalid({ message: parentRefInvalidMessage(target) }),
    branchNotFound: (target) =>
      new classes.branchNotFound({
        message: `Branch "${sanitizeInlineName(target)}" not found. Run \`supabase branches list\` to see available branches.${parentRefTypoHint(target)}`,
      }),
    branchNotReady: (target) =>
      new classes.branchNotReady({
        message: `Branch "${sanitizeInlineName(target)}" has no project ref yet. Wait for it to finish provisioning, then retry.`,
      }),
  };
}

/**
 * What {@link resolveConfigTarget} needs to know about a branch-lookup failure to decide
 * whether it was a 404. `status` is optional because only one arm of the `mapHttpError`
 * failure union carries an HTTP status; every other producer has none. `_tag` is required
 * so the interface isn't a TypeScript weak type.
 */
export interface ConfigTargetResolveFailure {
  readonly _tag: string;
  readonly status?: number | undefined;
}

// Not folded into `mapResolveError`: `config pull` shares one mapper across the branch
// lookup and the config read, so treating every 404 as "branch not found" here would
// misclassify a config-read 404.
function reclassifyBranchNotFoundError<E extends ConfigTargetResolveFailure, C>(
  cause: E,
  notFoundError: C,
): Effect.Effect<never, C | E> {
  return cause.status === 404 ? Effect.fail(notFoundError) : Effect.fail(cause);
}

/**
 * Resolves `--project-ref` to a {@link ConfigTarget}: a project ref, or the name/UUID of a
 * branch on the linked project. A ref-shaped value (20 lowercase letters) is always a project ref.
 *
 * A UUID branch needs no parent ref, so it works unlinked; a name branch resolves the parent
 * ref eagerly, before any spinner starts, so an unlinked or stale link fails immediately.
 */
export function resolveConfigTarget<TError, EResolve extends ConfigTargetResolveFailure>(
  requested: Option.Option<string>,
  errors: ConfigTargetErrors<TError>,
  /** Maps a branch-lookup (`GET`-by-UUID or `FIND`-by-name) transport/status failure. */
  mapResolveError: (cause: SupabaseApiError) => Effect.Effect<never, EResolve>,
) {
  return Effect.gen(function* () {
    const output = yield* Output;
    const resolver = yield* ProjectRefResolver;

    let ref: string;
    let branch: string | undefined;
    if (Option.isSome(requested) && !BRANCH_PROJECT_REF_PATTERN.test(requested.value)) {
      const target = requested.value;
      branch = target;

      let parentRef: ReturnType<typeof resolveParentScopedProjectRef>;
      if (BRANCH_UUID_PATTERN.test(target)) {
        parentRef = resolveParentScopedProjectRef(Option.none());
      } else {
        const parent = yield* resolveLinkedParentRef();
        if (parent.kind === "absent") {
          return yield* Effect.fail(errors.notLinked(target));
        }
        if (parent.kind === "invalid") {
          return yield* Effect.fail(errors.parentRefInvalid(target));
        }
        parentRef = Effect.succeed(parent.ref);
      }

      const resolving =
        output.format === "text" ? yield* output.task("Resolving branch...") : undefined;
      ref = yield* resolveBranchProjectRef(target, parentRef, {
        mapGetError: mapResolveError,
        mapFindError: mapResolveError,
      }).pipe(
        Effect.tapError(() => resolving?.fail() ?? Effect.void),
        Effect.catch((cause) =>
          reclassifyBranchNotFoundError(cause, errors.branchNotFound(target)),
        ),
      );
      yield* resolving?.clear() ?? Effect.void;

      // The resolved branch might not have a project ref yet (still provisioning); don't
      // let an empty ref reach the config-read call.
      if (!BRANCH_PROJECT_REF_PATTERN.test(ref)) {
        return yield* Effect.fail(errors.branchNotReady(target));
      }
    } else {
      ref = yield* resolver.resolve(requested);
    }

    return { ref, branch };
  });
}
