import { Effect, FileSystem, Option, Path } from "effect";
import * as HttpClientError from "effect/unstable/http/HttpClientError";

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
 *   - `"branch"` — `ref` is CONFIRMED to be a preview branch (an explicit
 *     `--project-ref <name-or-uuid>`, or a live 404). `parentRef`/
 *     `parentName`/`branch` are each present only when they could actually
 *     be determined — "confirmed branch, nothing else known" is exactly this
 *     shape with all three absent.
 *   - `"unknown"` — the live probe couldn't tell (a timeout, a transport
 *     failure, or a non-200/404 status, e.g. a scoped token that can write
 *     service config but can't read the project record). Never asserted as
 *     a branch: an uncertain outcome must not gate a plain, everyday push
 *     behind a confirmation that then auto-declines (and FAILS — see
 *     `push.handler.ts`) an unattended run over nothing more than network
 *     jitter. Never asserted as a project either — the target-echo line
 *     says plainly that it doesn't know.
 */
export type LegacyConfigPushTarget =
  | { readonly kind: "project"; readonly ref: string; readonly name?: string }
  | {
      readonly kind: "branch";
      readonly ref: string;
      readonly parentRef?: string;
      readonly parentName?: string;
      readonly branch?: string;
    }
  | { readonly kind: "unknown"; readonly ref: string };

/**
 * A branch name/UUID the caller already resolved `ref` from (CLI-2289's
 * `--project-ref <name-or-uuid>` path) — this makes the caller's knowledge
 * that `ref` is a branch DEFINITIVE, so {@link legacyResolveConfigPushTarget}
 * never runs the live `getProject` probe for it:
 *
 *   - `"name"` — both fields were resolved eagerly, nothing more to recover.
 *   - `"uuid"` — certain to be a branch, but a UUID carries no display name
 *     and never forces its parent (`GET /v1/branches/{id}` alone resolves
 *     it), so it runs the SAME best-effort cache recovery a live 404 does,
 *     to fill in whatever it can. A discriminated union rather than an
 *     all-optional shape: the only two states a real caller ever produces
 *     are "both known" and "neither known" — a partial state (a parent
 *     without a name, or vice versa) is not a shape this resolver needs to
 *     handle, so it doesn't exist to be handled incorrectly.
 */
export type LegacyConfigPushKnownBranch =
  | { readonly kind: "name"; readonly branchName: string; readonly parentRef: string }
  | { readonly kind: "uuid" };

/** `V1GetProjectOutput.name`/a branch's `name` are unconstrained strings — an
 * empty (or empty-after-sanitization-adjacent) live value must render as "no
 * name available", matching `legacyParseCachedLinkedProject`'s own
 * empty-filtering convention for cached names. */
function normalizeApiName(name: string | undefined): string | undefined {
  return name !== undefined && name.length > 0 ? name : undefined;
}

function isNotFound(cause: unknown): boolean {
  return (
    HttpClientError.isHttpClientError(cause) &&
    cause.response !== undefined &&
    cause.response.status === 404
  );
}

/**
 * Resolves what `ref` actually is, so `config push` can tell the user
 * whether they're pushing to the linked project or one of its branches
 * (CLI-2168), and so a branch push can be gated behind confirmation. NEVER
 * FAILS — matching `legacyFindBranchName`'s own best-effort contract, this
 * probe is diagnostic-only and must never abort a push that would otherwise
 * succeed.
 *
 *   - `opts.knownBranch?.kind === "name"`: no probe, no recovery — just
 *     enrich the parent's NAME from `.temp/linked-project.json` when its
 *     `ref` matches `parentRef`.
 *   - `opts.knownBranch?.kind === "uuid"`, or a live 404: `ref` is
 *     CONFIRMED a branch; run the shared best-effort recovery below.
 *   - Otherwise (`opts.knownBranch` absent): `GET /v1/projects/{ref}`,
 *     bounded at {@link LEGACY_BRANCH_LOOKUP_TIMEOUT} and wrapped in a
 *     `"Checking project..."` task. A 200 is a plain project. A TIMEOUT, a
 *     transport failure, or any status other than 200/404 is `"unknown"` —
 *     the task is marked failed (this diagnostic step genuinely didn't
 *     complete), but the push itself is never blocked by it. A 404 confirms
 *     a branch and falls into the same recovery as the `"uuid"` case.
 *
 * Shared best-effort recovery (a confirmed branch whose name/parent aren't
 * fully known yet):
 *   1. Read + parse `.temp/linked-project.json` — `cached`. No
 *      ref-pattern-valid, non-self-referential `cached.ref` → the bare
 *      `{ kind: "branch", ref }` shape, no further filesystem or API calls.
 *   2. Otherwise, read `.temp/project-ref` — `fileRef` — and best-effort
 *      look up the branch's own name among the candidate parent's branches
 *      ({@link legacyFindBranchName}).
 *   3. The branch-list lookup positively confirming the parent, OR `ref`
 *      being literally what `.temp/project-ref` currently holds —
 *      inheriting that file's own link-completed invariant (the same
 *      reasoning `legacy-linked-state.ts` documents for its own analogous
 *      case, restated here for a caller-supplied ref instead of a
 *      self-resolved one) — is what lets the parent claim stand. Neither →
 *      the bare `{ kind: "branch", ref }` shape, no parent claim at all.
 */
export function legacyResolveConfigPushTarget(
  ref: string,
  opts: { readonly knownBranch?: LegacyConfigPushKnownBranch },
): Effect.Effect<
  LegacyConfigPushTarget,
  never,
  LegacyPlatformApi | LegacyCliSettings | FileSystem.FileSystem | Path.Path | Output
> {
  return Effect.gen(function* () {
    const cliSettings = yield* LegacyCliSettings;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const linkedProjectCachePath = legacyTempPaths(path, cliSettings.workdir).linkedProjectCache;
    const readCachedParent = fs.readFileString(linkedProjectCachePath).pipe(
      Effect.map(legacyParseCachedLinkedProject),
      Effect.orElseSucceed(() => Option.none<LegacyCachedLinkedProject>()),
    );

    // Cheap path (a NAME target, CLI-2289): both fields already known — no
    // probe, no best-effort recovery, just enrich the parent's NAME from
    // cache when it happens to match.
    if (opts.knownBranch?.kind === "name") {
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

    // `opts.knownBranch?.kind === "uuid"` means the caller already knows FOR
    // CERTAIN `ref` is a branch: skip the live probe entirely. Otherwise,
    // run the probe — its only two "certain" outcomes are 200 (return
    // immediately) and 404 (fall through to the shared recovery below).
    if (opts.knownBranch === undefined) {
      const api = yield* LegacyPlatformApi;
      const output = yield* Output;
      const probing =
        output.format === "text" ? yield* output.task("Checking project...") : undefined;

      type ProbeOutcome =
        | { readonly kind: "project"; readonly name: string | undefined }
        | { readonly kind: "branch" }
        | { readonly kind: "unknown" };

      const probe: ProbeOutcome = yield* Effect.timeoutOrElse(
        api.v1.getProject({ ref }).pipe(
          Effect.map((project): ProbeOutcome => ({
            kind: "project",
            name: normalizeApiName(project.name),
          })),
          Effect.catch((cause) =>
            Effect.succeed<ProbeOutcome>(
              isNotFound(cause) ? { kind: "branch" } : { kind: "unknown" },
            ),
          ),
        ),
        {
          duration: LEGACY_BRANCH_LOOKUP_TIMEOUT,
          orElse: () => Effect.succeed<ProbeOutcome>({ kind: "unknown" }),
        },
      );
      // A definitive answer (200 or 404) clears the task normally; an
      // uncertain one (timeout, transport failure, or an unexpected status)
      // marks it failed — the diagnostic step genuinely didn't complete,
      // even though the push itself proceeds regardless.
      yield* (probe.kind === "unknown" ? probing?.fail() : probing?.clear()) ?? Effect.void;

      if (probe.kind === "project") {
        return { kind: "project", ref, ...(probe.name === undefined ? {} : { name: probe.name }) };
      }
      if (probe.kind === "unknown") {
        return { kind: "unknown", ref };
      }
      // probe.kind === "branch" (404) — fall into the shared recovery
      // below, same as a CONFIRMED-but-incomplete `knownBranch` (a UUID
      // target).
    }

    // Shared recovery — a CONFIRMED branch (a UUID target, or a live 404)
    // whose name/parent aren't known yet. Reads `.temp/project-ref` only
    // once there's an actual cache candidate to correlate it against, so
    // the common "cache absent" degradation path never touches the
    // filesystem a second time.
    const cached = yield* readCachedParent;
    const candidateParentRef =
      Option.isSome(cached) &&
      cached.value.ref !== ref &&
      LEGACY_BRANCH_PROJECT_REF_PATTERN.test(cached.value.ref)
        ? cached.value.ref
        : undefined;
    if (candidateParentRef === undefined) {
      return { kind: "branch", ref };
    }

    const fileRef = yield* legacyReadProjectRefFile(fs, path, cliSettings.workdir).pipe(
      Effect.orElseSucceed(() => Option.none<string>()),
    );
    const branchName = normalizeApiName(
      yield* legacyFindBranchName(candidateParentRef, ref, {
        spinnerLabel: "Checking branch name...",
      }),
    );
    const trusted = branchName !== undefined || (Option.isSome(fileRef) && fileRef.value === ref);
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
