import type { SupabaseApiError } from "@supabase/api/effect";
import { Data, Effect, Option } from "effect";

import { ProjectRefResolver } from "../../config/project-ref.service.ts";
import {
  parentNotLinkedMessage,
  parentRefInvalidMessage,
  parentRefTypoHint,
  resolveLinkedParentRef,
  resolveParentScopedProjectRef,
} from "../../command-internal/parent-project-ref.ts";
import { Output } from "../../shared/output/output.service.ts";
import { resolveBranchProjectRef } from "../../command-internal/branch-ref.resolver.ts";
import { sanitizeInlineName } from "../../command-internal/http-errors.ts";
import {
  BRANCH_PROJECT_REF_PATTERN,
  BRANCH_UUID_PATTERN,
} from "../../command-internal/ref-patterns.ts";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../shared/telemetry/error-actionability.ts";

/**
 * The resolved comparison/pull target for the `config` command family
 * (`diff`, `pull`, `push`): a project ref, plus the branch name/UUID
 * `--project-ref` carried when it named one — `undefined` for a ref-shaped or
 * linked-fallback target.
 */
export interface ConfigTarget {
  readonly ref: string;
  readonly branch: string | undefined;
}

/**
 * Builds the four target-resolution failures {@link resolveConfigTarget} can raise.
 * One type parameter, not four: every family's builder set is produced by
 * {@link configTargetErrorsFor}, whose return type unions the four minted classes, so
 * the resolver never has to infer them position-by-position.
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
 * Mints one `config` command family's four target-resolution error classes from its name
 * prefix (`"ConfigDiff"`, `"ConfigPull"`, `"ConfigPush"`). The classes
 * stay per-family so `_tag`, telemetry fingerprint, and actionability remain family-owned
 * and distinct; only their (identical) definitions live here.
 *
 * The tags are template-interpolated, so `error-actionability-coverage.unit.test.ts`'s
 * static AST scan cannot see them in THIS file — which is why every caller must re-export
 * each minted class from its own `*.errors.ts` under the family-prefixed name. That file
 * still declares other string-literal tags, so its coverage `it()` still registers, and the
 * runtime half of the guard walks `Object.entries(module)` and verifies these four there.
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
 * Wraps a family's four minted classes as the `errors` bundle
 * {@link resolveConfigTarget} takes. The message text is identical across every
 * family that resolves a branch-shaped `--project-ref`, so it lives here rather than being
 * restated in each handler. Four type parameters purely so the declared return type can
 * UNION them — the resolver itself then needs only one.
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
 * What {@link resolveConfigTarget} needs to know about a branch-lookup failure to
 * decide whether it was a 404. Every family's `mapResolveError` comes from
 * `mapHttpError`, whose failure union has exactly ONE arm carrying an HTTP status
 * (its `statusError` class, `{ status, body, message }`); the transport, request-validation,
 * and request-body arms carry none, and neither do the parent-ref resolver's failures.
 * Modelling `status` as optional is what lets that whole union satisfy this bound, and turns
 * the 404 test below into an ordinary typed field read instead of a `Predicate` duck-type
 * probe. `_tag` is required only so this is not a weak type.
 */
export interface ConfigTargetResolveFailure {
  readonly _tag: string;
  readonly status?: number | undefined;
}

/**
 * Reclassifies a status-shaped branch-lookup failure carrying a 404 as
 * `notFoundError`; every other status/network failure re-fails with its
 * original identity unchanged. A standalone generic function (rather than a
 * refinement passed to `Effect.catchIf`) so its own return type — a union of
 * two different `Effect` instantiations — is inferred directly from this
 * function's body instead of backward through `Effect.catch`'s inference.
 *
 * Deliberately NOT baked into `mapResolveError`: `config pull` shares ONE mapper across two
 * call sites (the branch lookup AND the `/v2/projects/{ref}/config` read — see
 * `pull.errors.ts`'s `ConfigPullReadNetworkError` doc comment), so folding the 404 rule
 * into the mapper would misreport a 404 from the unrelated config read as "branch not found".
 */
function reclassifyBranchNotFoundError<E extends ConfigTargetResolveFailure, C>(
  cause: E,
  notFoundError: C,
): Effect.Effect<never, C | E> {
  return cause.status === 404 ? Effect.fail(notFoundError) : Effect.fail(cause);
}

/**
 * Resolves `--project-ref` to a {@link ConfigTarget}. `--project-ref`
 * accepts a project ref, or the name (or UUID) of a branch of the linked
 * project — `link`'s settled vocabulary (CLI-2167). A ref-shaped value
 * (exactly 20 lowercase letters) is always treated as a project ref.
 *
 * A UUID target resolves through `GET /v1/branches/{id}` directly, which
 * needs no parent ref at all, so it keeps the fully lazy parent resolution
 * below — the parent-scoped resolver is never evaluated for it, which is
 * exactly what lets it work in an unlinked directory.
 *
 * A NAME target, by contrast, needs the parent project ref to search under,
 * so it is resolved eagerly, BEFORE any spinner starts — mirroring `link`
 * (link.handler.ts:198-213): an unlinked directory (or a corrupt/stale linked
 * ref) must fail immediately with a link-grade error naming the value the
 * user passed, rather than falling through to `resolver.resolve`'s
 * interactive project picker rendering under a live "Resolving branch..."
 * spinner.
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

      // The resolved branch might not have a project ref yet (still
      // provisioning) — never let an empty/placeholder ref reach the
      // config-read call (mirrors link.handler.ts:248-256's guard).
      if (!BRANCH_PROJECT_REF_PATTERN.test(ref)) {
        return yield* Effect.fail(errors.branchNotReady(target));
      }
    } else {
      ref = yield* resolver.resolve(requested);
    }

    return { ref, branch };
  });
}
