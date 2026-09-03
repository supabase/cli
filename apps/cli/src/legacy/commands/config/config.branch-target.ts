import type { SupabaseApiError } from "@supabase/api/effect";
import { Effect, Option } from "effect";
import * as HttpClientError from "effect/unstable/http/HttpClientError";

import { LegacyProjectRefResolver } from "../../config/legacy-project-ref.service.ts";
import {
  type LegacyBranchRefResolveMappers,
  legacyResolveBranchProjectRef,
} from "../../shared/legacy-branch-ref.resolver.ts";
import {
  legacyParentNotLinkedMessage,
  legacyParentRefInvalidMessage,
  legacyParentRefTypoHint,
  legacyResolveLinkedParentRef,
  legacyResolveParentScopedProjectRef,
} from "../../shared/legacy-parent-project-ref.ts";
import {
  LEGACY_BRANCH_PROJECT_REF_PATTERN,
  LEGACY_BRANCH_UUID_PATTERN,
} from "../../shared/legacy-ref-patterns.ts";
import { legacySanitizeInlineName } from "../../shared/legacy-http-errors.ts";
import { Output } from "../../../shared/output/output.service.ts";

/**
 * A branch name/UUID resolved as an EXPLICIT `--project-ref` target this
 * invocation (CLI-2289). `branchName`/`parentRef` are both present for a NAME
 * target (its parent is resolved eagerly, before any spinner starts); a UUID
 * target resolves through `GET /v1/branches/{id}` alone — it never forces a
 * parent, so it always carries neither field (a UUID is an identifier, not a
 * display name).
 */
export interface LegacyConfigTargetBranchResolution {
  readonly branchName?: string;
  readonly parentRef?: string;
}

export interface LegacyConfigTargetResolution {
  readonly ref: string;
  /** Present only when `requested` was resolved as an explicit branch
   * name/UUID this call — absent for a bare ref or the resolver's own
   * implicit fallback (`resolver.resolve`). */
  readonly branchResolution?: LegacyConfigTargetBranchResolution;
}

/**
 * Per-caller error identities for {@link legacyResolveConfigTargetRef} — every
 * caller keeps its own tagged error classes/messages (mirrors
 * `LegacyBranchRefResolveMappers`'s own injection pattern, and
 * `legacyClassifyProjectLookupError`'s).
 */
export interface LegacyConfigTargetResolveErrors<
  ENotLinked,
  EInvalid,
  ENotFound,
  ENotReady,
  EGet,
  EFind,
> {
  readonly notLinkedError: (opts: { readonly message: string }) => Effect.Effect<never, ENotLinked>;
  readonly parentRefInvalidError: (opts: {
    readonly message: string;
  }) => Effect.Effect<never, EInvalid>;
  readonly branchNotFoundError: (opts: {
    readonly message: string;
  }) => Effect.Effect<never, ENotFound>;
  readonly branchNotReadyError: (opts: {
    readonly message: string;
  }) => Effect.Effect<never, ENotReady>;
  /**
   * Maps a branch-resolution HTTP failure (built with `mapLegacyHttpError`,
   * same as every other Management API call in this codebase). A 404 on
   * either lookup is intercepted BEFORE it ever reaches these mappers —
   * translated straight to `branchNotFoundError` instead — so neither needs
   * to special-case it itself.
   */
  readonly mapResolveError: LegacyBranchRefResolveMappers<EGet, EFind>;
}

/**
 * Resolves `--project-ref`'s accepted vocabulary — a project ref, or the name
 * (or UUID) of a branch of the linked project (CLI-2167/CLI-2289) — to a
 * concrete project ref. Shared by `config diff` and `config push` (Hoist
 * Before You Duplicate: ≥2 commands in the `commands/config/` family); each
 * caller keeps its own tagged error identities via `errors`.
 *
 *   - `requested` absent, or ref-shaped (exactly 20 lowercase letters) →
 *     `resolver.resolve(requested)` unchanged. `branchResolution` absent.
 *   - `requested` is a UUID → resolves via `GET /v1/branches/{id}`
 *     (`legacyResolveBranchProjectRef`'s UUID path) against a LAZILY-evaluated
 *     parent that this path never forces — the UUID endpoint needs no parent
 *     at all, so this keeps `--project-ref <uuid>` working in an unlinked
 *     directory. `branchResolution` is present but empty (`{}`): the target
 *     is CERTAIN to be a branch, but a UUID carries no display name.
 *   - `requested` is a NAME → the parent project ref is resolved EAGERLY,
 *     before any spinner starts (`legacyResolveLinkedParentRef`), failing
 *     fast with `errors.notLinkedError`/`errors.parentRefInvalidError` naming
 *     the value the user passed; then resolves via
 *     `GET /v1/projects/{parent_ref}/branches/{name}`. `branchResolution`
 *     carries `{branchName, parentRef}`.
 *
 * Either branch path shows a `"Resolving branch..."` spinner in text mode,
 * fails with `errors.branchNotFoundError` on a 404, and with
 * `errors.branchNotReadyError` when the resolved branch has no project ref
 * yet (still provisioning) — byte-identical wording to what `config diff`
 * shipped first (`diff.integration.test.ts` pins it).
 */
export function legacyResolveConfigTargetRef<
  ENotLinked,
  EInvalid,
  ENotFound,
  ENotReady,
  EGet,
  EFind,
>(
  requested: Option.Option<string>,
  errors: LegacyConfigTargetResolveErrors<ENotLinked, EInvalid, ENotFound, ENotReady, EGet, EFind>,
) {
  return Effect.gen(function* () {
    const resolver = yield* LegacyProjectRefResolver;

    if (Option.isNone(requested) || LEGACY_BRANCH_PROJECT_REF_PATTERN.test(requested.value)) {
      return { ref: yield* resolver.resolve(requested) } satisfies LegacyConfigTargetResolution;
    }

    const target = requested.value;
    const isUuidTarget = LEGACY_BRANCH_UUID_PATTERN.test(target);
    const output = yield* Output;

    let parentRef: ReturnType<typeof legacyResolveParentScopedProjectRef>;
    if (isUuidTarget) {
      parentRef = legacyResolveParentScopedProjectRef(Option.none());
    } else {
      const parent = yield* legacyResolveLinkedParentRef();
      if (parent.kind === "absent") {
        return yield* errors.notLinkedError({ message: legacyParentNotLinkedMessage(target) });
      }
      if (parent.kind === "invalid") {
        return yield* errors.parentRefInvalidError({
          message: legacyParentRefInvalidMessage(target),
        });
      }
      parentRef = Effect.succeed(parent.ref);
    }

    // A 404 on EITHER lookup means "no such branch" — intercept it at the
    // transport level, before it ever reaches the caller's own
    // network/status mapper, so neither `mapGetError` nor `mapFindError`
    // needs to special-case it (mirrors the identical
    // `Effect.catchTag(...cause.status === 404...)` both `config diff` and
    // `config push` carried inline before this hoist).
    const notFoundAware =
      <E>(
        mapper: (cause: SupabaseApiError) => Effect.Effect<never, E>,
      ): ((cause: SupabaseApiError) => Effect.Effect<never, E | ENotFound>) =>
      (cause) =>
        HttpClientError.isHttpClientError(cause) &&
        cause.response !== undefined &&
        cause.response.status === 404
          ? errors.branchNotFoundError({
              message: `Branch "${legacySanitizeInlineName(target)}" not found. Run \`supabase branches list\` to see available branches.${legacyParentRefTypoHint(target)}`,
            })
          : mapper(cause);

    const resolving =
      output.format === "text" ? yield* output.task("Resolving branch...") : undefined;
    const ref = yield* legacyResolveBranchProjectRef(target, parentRef, {
      mapGetError: notFoundAware(errors.mapResolveError.mapGetError),
      mapFindError: notFoundAware(errors.mapResolveError.mapFindError),
    }).pipe(Effect.tapError(() => resolving?.fail() ?? Effect.void));
    yield* resolving?.clear() ?? Effect.void;

    // The resolved branch might not have a project ref yet (still
    // provisioning) — never let an empty/placeholder ref reach a caller.
    if (!LEGACY_BRANCH_PROJECT_REF_PATTERN.test(ref)) {
      return yield* errors.branchNotReadyError({
        message: `Branch "${legacySanitizeInlineName(target)}" has no project ref yet. Wait for it to finish provisioning, then retry.`,
      });
    }

    return {
      ref,
      branchResolution: isUuidTarget ? {} : { branchName: target, parentRef: yield* parentRef },
    } satisfies LegacyConfigTargetResolution;
  });
}
