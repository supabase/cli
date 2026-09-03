import { Effect, FileSystem, Option, Path } from "effect";

import { LegacyPlatformApi } from "../../../auth/legacy-platform-api.service.ts";
import { LegacyCliSettings } from "../../../config/legacy-cli-settings.service.ts";
import {
  LEGACY_BRANCH_LOOKUP_TIMEOUT,
  legacyFindBranchName,
} from "../../../shared/legacy-branch-target.ts";
import {
  type LegacyCachedLinkedProject,
  legacyParseCachedLinkedProject,
} from "../../../shared/legacy-parent-project-ref.ts";
import { LEGACY_BRANCH_PROJECT_REF_PATTERN } from "../../../shared/legacy-ref-patterns.ts";
import { legacyReadProjectRefFile, legacyTempPaths } from "../../../shared/legacy-temp-paths.ts";
import { Output } from "../../../../shared/output/output.service.ts";

/**
 * What `ref` actually is, resolved for `config push`'s target-echo + branch
 * gate (CLI-2168):
 *
 *   - `"project"` — `ref` is the linked project itself. `name` is present
 *     when the live probe below found it.
 *   - `"branch"` — `ref` is a preview branch. `parentRef`/`parentName`/
 *     `branch` are each present only when they could actually be determined
 *     — "assumed branch, nothing else known" is exactly this shape with all
 *     three absent.
 */
export type LegacyConfigPushTarget =
  | { readonly kind: "project"; readonly ref: string; readonly name?: string }
  | {
      readonly kind: "branch";
      readonly ref: string;
      readonly parentRef?: string;
      readonly parentName?: string;
      readonly branch?: string;
    };

/**
 * What the caller already knows about `ref` being a branch (CLI-2289's
 * `--project-ref <name-or-uuid>` path) — this makes the caller's knowledge
 * that `ref` is a branch CERTAIN, so {@link legacyResolveConfigPushTarget}
 * never runs the live `getProject` probe for it, regardless of which fields
 * are present:
 *
 *   - `{branchName, parentRef}` both present — a NAME target: both were
 *     resolved eagerly, nothing more to recover.
 *   - `{}` (both absent) — a UUID target: certain to be a branch, but a UUID
 *     carries no display name and never forces its parent, so neither field
 *     is known yet. Runs the SAME best-effort cache recovery the bare-404
 *     path uses, to fill in whatever it can.
 */
export interface LegacyConfigPushKnownBranch {
  readonly branchName?: string;
  readonly parentRef?: string;
}

type LegacyConfigPushProbeOutcome =
  | { readonly kind: "project"; readonly name: string | undefined }
  | { readonly kind: "branch-uncertain" }
  | { readonly kind: "timeout" };

/** `V1GetProjectOutput.name`/a branch's `name` are unconstrained strings — an
 * empty (or empty-after-sanitization-adjacent) live value must render as "no
 * name available", matching `legacyParseCachedLinkedProject`'s own
 * empty-filtering convention for cached names. */
function normalizeApiName(name: string | undefined): string | undefined {
  return name !== undefined && name.length > 0 ? name : undefined;
}

/**
 * Resolves what `ref` actually is, so `config push` can tell the user
 * whether they're pushing to the linked project or one of its branches
 * (CLI-2168), and so a branch push can be gated behind confirmation.
 *
 *   - `opts.knownBranch` has both `branchName`/`parentRef` (a NAME target,
 *     CLI-2289): no probe, no recovery — just enrich the parent's NAME from
 *     `.temp/linked-project.json` when its `ref` matches `parentRef`.
 *   - `opts.knownBranch` is present but incomplete (a UUID target — `{}`):
 *     no probe either (the target is CERTAIN to be a branch), but falls into
 *     the SAME best-effort recovery below a bare 404 uses, to try to
 *     correlate a real name/parent from cache.
 *   - `opts.knownBranch` is absent: `GET /v1/projects/{ref}` (via
 *     `opts.classifyLookupError`, `legacyClassifyProjectLookupError`'s
 *     contract), bounded at {@link LEGACY_BRANCH_LOOKUP_TIMEOUT} and wrapped
 *     in a `"Checking project..."` task. A 200 is a plain project; a
 *     TIMEOUT degrades directly to the bare `{ kind: "branch", ref }` shape
 *     (uncertain, but must never silently default to "project" and skip the
 *     confirmation gate, nor hard-abort the whole command over a slow read);
 *     a 404 means `ref` is a branch whose name/parent are not yet known, so
 *     it falls into the same best-effort recovery as the incomplete-
 *     `knownBranch` case above:
 *       1. Read + parse `.temp/linked-project.json` — `cached`. No
 *          ref-pattern-valid, non-self-referential `cached.ref` (and no
 *          `opts.knownBranch?.parentRef` either) → the bare
 *          `{ kind: "branch", ref }` shape, no further filesystem or API
 *          calls at all.
 *       2. Otherwise, read `.temp/project-ref` — `fileRef` — and best-effort
 *          look up the branch's own name among the candidate parent's
 *          branches ({@link legacyFindBranchName}), unless `opts.knownBranch`
 *          already carries a name.
 *       3. A parent the CALLER already certified (the UUID path) is trusted
 *          outright. A cache-derived candidate still needs the SAME positive
 *          confirmation the bare-404 path always required: the branch-list
 *          lookup positively confirmed it, OR `ref` is literally what
 *          `.temp/project-ref` currently holds — inheriting that file's own
 *          link-completed invariant (the same reasoning `legacy-linked-state.ts`
 *          documents for its own analogous case, restated here for a
 *          caller-supplied ref instead of a self-resolved one). Untrusted →
 *          the bare `{ kind: "branch", ref }` shape, no parent claim at all.
 */
export function legacyResolveConfigPushTarget<E>(
  ref: string,
  opts: {
    readonly classifyLookupError: (cause: unknown) => Effect.Effect<Option.Option<never>, E>;
    readonly knownBranch?: LegacyConfigPushKnownBranch;
  },
): Effect.Effect<
  LegacyConfigPushTarget,
  E,
  LegacyPlatformApi | LegacyCliSettings | FileSystem.FileSystem | Path.Path | Output
> {
  return Effect.gen(function* () {
    const cliSettings = yield* LegacyCliSettings;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const output = yield* Output;
    const linkedProjectCachePath = legacyTempPaths(path, cliSettings.workdir).linkedProjectCache;
    const readCachedParent = fs.readFileString(linkedProjectCachePath).pipe(
      Effect.map(legacyParseCachedLinkedProject),
      Effect.orElseSucceed(() => Option.none<LegacyCachedLinkedProject>()),
    );

    // Cheap path (a NAME target, CLI-2289): both fields already known — no
    // probe, no best-effort recovery, just enrich the parent's NAME from
    // cache when it happens to match.
    if (opts.knownBranch?.branchName !== undefined && opts.knownBranch.parentRef !== undefined) {
      const { branchName, parentRef } = opts.knownBranch;
      const cached = yield* readCachedParent;
      const parentName =
        Option.isSome(cached) && cached.value.ref === parentRef ? cached.value.name : undefined;
      return {
        kind: "branch",
        ref,
        parentRef,
        ...(parentName === undefined ? {} : { parentName }),
        branch: branchName,
      };
    }

    // `opts.knownBranch` present at all (even empty — a UUID target) means
    // the caller already knows FOR CERTAIN `ref` is a branch: skip the live
    // probe entirely and fall straight into the shared recovery below.
    if (opts.knownBranch === undefined) {
      const api = yield* LegacyPlatformApi;
      const probing =
        output.format === "text" ? yield* output.task("Checking project...") : undefined;
      const probe: LegacyConfigPushProbeOutcome = yield* Effect.timeoutOrElse(
        api.v1.getProject({ ref }).pipe(
          Effect.map((project): LegacyConfigPushProbeOutcome => ({
            kind: "project",
            name: normalizeApiName(project.name),
          })),
          Effect.catch((cause) =>
            Effect.map(opts.classifyLookupError(cause), (): LegacyConfigPushProbeOutcome => ({
              kind: "branch-uncertain",
            })),
          ),
        ),
        {
          duration: LEGACY_BRANCH_LOOKUP_TIMEOUT,
          orElse: () => Effect.succeed<LegacyConfigPushProbeOutcome>({ kind: "timeout" }),
        },
      ).pipe(Effect.ensuring(probing?.clear() ?? Effect.void));

      if (probe.kind === "project") {
        return { kind: "project", ref, ...(probe.name === undefined ? {} : { name: probe.name }) };
      }
      if (probe.kind === "timeout") {
        return { kind: "branch", ref };
      }
      // probe.kind === "branch-uncertain" (404) — fall into the shared
      // recovery below, same as a CERTAIN-but-incomplete `knownBranch`.
    }

    // Best-effort recovery — shared by the live probe's 404 and a
    // CERTAIN-but-incomplete `knownBranch` (a UUID target). Reads
    // `.temp/project-ref` only once there's an actual cache candidate to
    // correlate it against, so the common "cache absent" degradation path
    // never touches the filesystem a second time.
    const cached = yield* readCachedParent;
    const cachedCandidateParentRef =
      Option.isSome(cached) &&
      cached.value.ref !== ref &&
      LEGACY_BRANCH_PROJECT_REF_PATTERN.test(cached.value.ref)
        ? cached.value.ref
        : undefined;
    const candidateParentRef = opts.knownBranch?.parentRef ?? cachedCandidateParentRef;
    if (candidateParentRef === undefined) {
      return { kind: "branch", ref };
    }

    const fileRef = yield* legacyReadProjectRefFile(fs, path, cliSettings.workdir).pipe(
      Effect.orElseSucceed(() => Option.none<string>()),
    );
    let branchName: string | undefined;
    if (opts.knownBranch?.branchName !== undefined) {
      branchName = opts.knownBranch.branchName;
    } else {
      branchName = normalizeApiName(yield* legacyFindBranchName(candidateParentRef, ref));
    }
    // A parent the CALLER already certified is trusted outright — nothing
    // left to verify. A cache-derived candidate still needs the SAME
    // positive confirmation the bare-404 path always required.
    const trusted =
      opts.knownBranch?.parentRef !== undefined ||
      branchName !== undefined ||
      (Option.isSome(fileRef) && fileRef.value === ref);
    if (!trusted) {
      return { kind: "branch", ref };
    }

    const parentName =
      Option.isSome(cached) && cached.value.ref === candidateParentRef
        ? cached.value.name
        : undefined;
    return {
      kind: "branch",
      ref,
      parentRef: candidateParentRef,
      ...(parentName === undefined ? {} : { parentName }),
      ...(branchName === undefined ? {} : { branch: branchName }),
    };
  });
}
