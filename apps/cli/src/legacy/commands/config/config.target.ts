import type { SupabaseApiError } from "@supabase/api/effect";
import { Effect, Option, Predicate } from "effect";

import { LegacyProjectRefResolver } from "../../config/legacy-project-ref.service.ts";
import {
  legacyResolveLinkedParentRef,
  legacyResolveParentScopedProjectRef,
} from "../../shared/legacy-parent-project-ref.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { legacyResolveBranchProjectRef } from "../../shared/legacy-branch-ref.resolver.ts";
import {
  LEGACY_BRANCH_PROJECT_REF_PATTERN,
  LEGACY_BRANCH_UUID_PATTERN,
} from "../../shared/legacy-ref-patterns.ts";

/**
 * The resolved comparison/pull target for the `config` command family
 * (`diff`, `pull`): a project ref, plus the branch name/UUID `--project-ref`
 * carried when it named one — `undefined` for a ref-shaped or
 * linked-fallback target.
 */
export interface LegacyConfigTarget {
  readonly ref: string;
  readonly branch: string | undefined;
}

/**
 * Per-family error construction for {@link legacyResolveConfigTarget}: every
 * caller keeps its own tagged error classes (built with `mapLegacyHttpError`
 * for the network/status pair) so error identities, messages, and
 * actionability stay family-owned — mirrors `LegacyBranchRefResolveMappers`
 * (`legacy-branch-ref.resolver.ts`). Every constructor receives the raw
 * `target` value the user passed, so each family builds its own
 * message text (`legacyParentNotLinkedMessage`, etc.) itself.
 */
export interface LegacyConfigTargetErrors<A, B, C, D, E> {
  /**
   * `target` was named as a branch, but no project is linked to search for
   * branches under — none of `SUPABASE_PROJECT_ID`,
   * `supabase/.temp/linked-project.json`, or `supabase/.temp/project-ref`
   * yielded a candidate.
   */
  readonly notLinked: (target: string) => A;
  /**
   * `target` was named as a branch, and a parent-project candidate exists
   * but is not ref-shaped — corrupt or stale linked state.
   */
  readonly parentRefInvalid: (target: string) => B;
  /** `target` named a branch the parent project does not have. */
  readonly branchNotFound: (target: string) => C;
  /** The resolved branch has no project ref yet (still provisioning). */
  readonly branchNotReady: (target: string) => D;
  /** Maps a branch-lookup (`GET`-by-UUID or `FIND`-by-name) transport/status failure. */
  readonly mapResolveError: (cause: SupabaseApiError) => Effect.Effect<never, E>;
}

/**
 * Reclassifies a status-shaped branch-lookup failure carrying a 404 as
 * `notFoundError`; every other status/network failure re-fails with its
 * original identity unchanged. A standalone generic function (rather than a
 * refinement passed to `Effect.catchIf`) so its own return type — a union of
 * two different `Effect` instantiations — is inferred directly from this
 * function's body instead of backward through `Effect.catch`'s inference.
 */
function reclassifyBranchNotFoundError<E, C>(
  cause: E,
  notFoundError: C,
): Effect.Effect<never, C | E> {
  return Predicate.hasProperty("status")(cause) && cause.status === 404
    ? Effect.fail(notFoundError)
    : Effect.fail(cause);
}

/**
 * Resolves `--project-ref` to a {@link LegacyConfigTarget}. `--project-ref`
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
export function legacyResolveConfigTarget<A, B, C, D, E>(
  requested: Option.Option<string>,
  errors: LegacyConfigTargetErrors<A, B, C, D, E>,
) {
  return Effect.gen(function* () {
    const output = yield* Output;
    const resolver = yield* LegacyProjectRefResolver;

    let ref: string;
    let branch: string | undefined;
    if (Option.isSome(requested) && !LEGACY_BRANCH_PROJECT_REF_PATTERN.test(requested.value)) {
      const target = requested.value;
      branch = target;

      let parentRef: ReturnType<typeof legacyResolveParentScopedProjectRef>;
      if (LEGACY_BRANCH_UUID_PATTERN.test(target)) {
        parentRef = legacyResolveParentScopedProjectRef(Option.none());
      } else {
        const parent = yield* legacyResolveLinkedParentRef();
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
      ref = yield* legacyResolveBranchProjectRef(target, parentRef, {
        mapGetError: errors.mapResolveError,
        mapFindError: errors.mapResolveError,
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
      if (!LEGACY_BRANCH_PROJECT_REF_PATTERN.test(ref)) {
        return yield* Effect.fail(errors.branchNotReady(target));
      }
    } else {
      ref = yield* resolver.resolve(requested);
    }

    return { ref, branch };
  });
}
