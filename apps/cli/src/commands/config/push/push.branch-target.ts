import { Effect, FileSystem, Option, Path } from "effect";
import * as HttpClientError from "effect/unstable/http/HttpClientError";

import { CommandPlatformApi } from "../../../auth/command-platform-api.service.ts";
import { CommandSettings } from "../../../config/command-settings.service.ts";
import { BRANCH_LOOKUP_TIMEOUT, findBranchName } from "../../../command-internal/branch-target.ts";
import {
  type CachedLinkedProject,
  parseCachedLinkedProject,
} from "../../../command-internal/parent-project-ref.ts";
import { BRANCH_PROJECT_REF_PATTERN } from "../../../command-internal/ref-patterns.ts";
import { readProjectRefFile, tempPaths } from "../../../command-internal/temp-paths.ts";
import { Output } from "../../../shared/output/output.service.ts";

/**
 * What `ref` actually is, resolved for `config push`'s target-echo and branch confirmation gate:
 *
 * - `"project"` — `ref` is the linked project itself; `name` is present when the live probe
 *   found it.
 * - `"branch"` — `ref` is confirmed to be a preview branch (an explicit `--project-ref
 *   <name-or-uuid>`, or a live 404); `parentRef`/`parentName`/`branch` are each present only
 *   when they could be determined.
 * - `"unknown"` — the live probe couldn't tell (a timeout, a transport failure, or an
 *   unexpected status). Never asserted as a branch, since an uncertain outcome must not gate an
 *   unattended push behind a confirmation that then auto-declines it; never asserted as a
 *   project either — the target-echo line says plainly that it doesn't know.
 */
export type ConfigPushTarget =
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
 * A branch name/UUID the caller already resolved `ref` from — this makes the caller's knowledge
 * that `ref` is a branch definitive, so {@link resolveConfigPushTarget} never runs the live
 * `getProject` probe for it:
 *
 * - `"name"` — both fields were resolved eagerly, nothing more to recover.
 * - `"uuid"` — certain to be a branch, but a UUID carries no display name and never forces its
 *   parent, so it runs the same best-effort cache recovery a live 404 does. A discriminated
 *   union rather than an all-optional shape, since a partial state (a parent without a name, or
 *   vice versa) never occurs in practice.
 */
export type ConfigPushKnownBranch =
  | { readonly kind: "name"; readonly branchName: string; readonly parentRef: string }
  | { readonly kind: "uuid" };

/** `V1GetProjectOutput.name`/a branch's `name` are unconstrained strings — an
 * empty (or empty-after-sanitization-adjacent) live value must render as "no
 * name available", matching `parseCachedLinkedProject`'s own
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
 * Resolves what `ref` actually is, so `config push` can tell the user whether they're pushing to
 * the linked project or a branch, and gate a branch push behind confirmation. Never fails: this
 * probe is diagnostic-only and must never abort a push that would otherwise succeed.
 *
 * A known branch name/UUID skips the live probe. Otherwise `GET /v1/projects/{ref}` (bounded at
 * {@link BRANCH_LOOKUP_TIMEOUT}) returns a project on 200, `"unknown"` on any other failure
 * (never blocking the push), or falls into best-effort recovery on a 404:
 * `.temp/linked-project.json` and `.temp/project-ref` supply the parent ref and branch name when
 * they can be trusted, and a bare `{ kind: "branch", ref }` otherwise.
 */
export function resolveConfigPushTarget(
  ref: string,
  opts: { readonly knownBranch?: ConfigPushKnownBranch },
): Effect.Effect<
  ConfigPushTarget,
  never,
  CommandPlatformApi | CommandSettings | FileSystem.FileSystem | Path.Path | Output
> {
  return Effect.gen(function* () {
    const cliSettings = yield* CommandSettings;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const linkedProjectCachePath = tempPaths(path, cliSettings.workdir).linkedProjectCache;
    const readCachedParent = fs.readFileString(linkedProjectCachePath).pipe(
      Effect.map(parseCachedLinkedProject),
      Effect.orElseSucceed(() => Option.none<CachedLinkedProject>()),
    );

    // A name target: both fields already known, so just enrich the parent's name from cache
    // when it happens to match.
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

    // A uuid known-branch means ref is certainly a branch, so skip the live probe. Otherwise
    // the probe's only certain outcomes are 200 (return immediately) and 404 (fall through to
    // shared recovery).
    if (opts.knownBranch === undefined) {
      const api = yield* CommandPlatformApi;
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
          duration: BRANCH_LOOKUP_TIMEOUT,
          orElse: () => Effect.succeed<ProbeOutcome>({ kind: "unknown" }),
        },
      );
      // A definitive answer (200 or 404) clears the task; an uncertain one marks it failed
      // since the diagnostic step didn't complete, though the push proceeds regardless.
      yield* (probe.kind === "unknown" ? probing?.fail() : probing?.clear()) ?? Effect.void;

      if (probe.kind === "project") {
        return { kind: "project", ref, ...(probe.name === undefined ? {} : { name: probe.name }) };
      }
      if (probe.kind === "unknown") {
        return { kind: "unknown", ref };
      }
      // probe.kind === "branch" (404) falls into the shared recovery below, same as an
      // incomplete uuid knownBranch.
    }

    // Shared recovery for a confirmed branch whose name/parent aren't known yet. Reads
    // .temp/project-ref only once there's a cache candidate to correlate it against, so the
    // common cache-absent path skips a second filesystem read.
    const cached = yield* readCachedParent;
    const candidateParentRef =
      Option.isSome(cached) &&
      cached.value.ref !== ref &&
      BRANCH_PROJECT_REF_PATTERN.test(cached.value.ref)
        ? cached.value.ref
        : undefined;
    if (candidateParentRef === undefined) {
      return { kind: "branch", ref };
    }

    const fileRef = yield* readProjectRefFile(fs, path, cliSettings.workdir).pipe(
      Effect.orElseSucceed(() => Option.none<string>()),
    );
    const branchName = normalizeApiName(
      yield* findBranchName(candidateParentRef, ref, {
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
