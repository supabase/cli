import { Data, Effect, FileSystem, Option, Path } from "effect";
import * as HttpClientError from "effect/http/HttpClientError";

import { CommandPlatformApi } from "../../../auth/command-platform-api.service.ts";
import { CommandSettings } from "../../../config/command-settings.service.ts";
import { BRANCH_LOOKUP_TIMEOUT, findBranchName } from "../../../command-internal/branch-target.ts";
import {
  type CachedLinkedProject,
  parseCachedLinkedProject,
} from "../../../command-internal/parent-project-ref.ts";
import { BRANCH_PROJECT_REF_PATTERN } from "../../../command-internal/ref-patterns.ts";
import { readProjectRefFile, tempPaths } from "../../../shared/config/temp-paths.ts";
import { Output } from "../../../shared/output/output.service.ts";

/**
 * What `ref` actually is, resolved for `config push`'s payload:
 *
 * - `"project"` — `ref` is the linked or production project itself.
 * - `"branch"` — `ref` is confirmed to be a preview branch (a `--remote` branch, or a live 404);
 *   `parentRef`/`branch` are each present only when they could be determined.
 * - `"unknown"` — nothing could settle it (a probe timeout, transport failure or unexpected
 *   status, or a UUID looked up with no linked project). Asserted as neither a branch nor a project.
 */
export type ConfigPushTarget =
  | { readonly kind: "project"; readonly ref: string }
  | {
      readonly kind: "branch";
      readonly ref: string;
      readonly parentRef?: string;
      readonly branch?: string;
    }
  | { readonly kind: "unknown"; readonly ref: string };

/**
 * What the caller already knows about the `--remote` branch name/UUID `ref` was resolved from, so
 * {@link resolveConfigPushTarget} never runs the live `getProject` probe for it:
 *
 * - `"name"` — a branch found by name under its parent; both fields are known.
 * - `"uuid"` — certainly a branch, but a UUID carries no display name and never forces its parent,
 *   so it runs the same best-effort cache recovery a live 404 does.
 * - `"production"` — the project's default branch, which is the project itself.
 * - `"unverified"` — a UUID looked up with no linked project, which says nothing about `ref`.
 */
export type ConfigPushKnownBranch =
  | { readonly kind: "name"; readonly branchName: string; readonly parentRef: string }
  | { readonly kind: "uuid" }
  | { readonly kind: "production" }
  | { readonly kind: "unverified" };

/** An API name is an unconstrained string; an empty one means "no name available". */
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

type ProbeOutcome = Data.TaggedEnum<{
  Project: {};
  Branch: {};
  Unknown: {};
}>;
const ProbeOutcome = Data.taggedEnum<ProbeOutcome>();

/**
 * Resolves what `ref` actually is, so `config push` can tell a branch from the linked project.
 * Never fails: this probe is diagnostic-only and must never abort a push that would otherwise
 * succeed.
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

    if (opts.knownBranch?.kind === "name") {
      const { branchName, parentRef } = opts.knownBranch;
      return { kind: "branch", ref, parentRef, branch: branchName };
    }
    if (opts.knownBranch?.kind === "production") return { kind: "project", ref };
    if (opts.knownBranch?.kind === "unverified") return { kind: "unknown", ref };

    // A known branch skips the live probe; otherwise its only certain outcomes are 200 (return)
    // and 404 (fall through to the shared recovery).
    if (opts.knownBranch === undefined) {
      const api = yield* CommandPlatformApi;
      const output = yield* Output;
      const probing =
        output.format === "text" ? yield* output.task("Checking project...") : undefined;

      const probe: ProbeOutcome = yield* Effect.timeoutOrElse(
        api.v1.getProject({ ref }).pipe(
          Effect.map(() => ProbeOutcome.Project()),
          Effect.catch((cause) =>
            Effect.succeed(isNotFound(cause) ? ProbeOutcome.Branch() : ProbeOutcome.Unknown()),
          ),
        ),
        {
          duration: BRANCH_LOOKUP_TIMEOUT,
          orElse: () => Effect.succeed(ProbeOutcome.Unknown()),
        },
      );
      // A definitive answer (200 or 404) clears the task; an uncertain one marks it failed
      // since the diagnostic step didn't complete, though the push proceeds regardless.
      yield* (ProbeOutcome.$is("Unknown")(probe) ? probing?.fail() : probing?.clear) ?? Effect.void;

      const probed = ProbeOutcome.$match(probe, {
        Project: (): ConfigPushTarget => ({ kind: "project", ref }),
        Unknown: (): ConfigPushTarget => ({ kind: "unknown", ref }),
        // A 404 falls into the shared recovery below, same as a uuid known branch.
        Branch: () => undefined,
      });
      if (probed !== undefined) {
        return probed;
      }
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

    return {
      kind: "branch",
      ref,
      parentRef: candidateParentRef,
      ...(branchName === undefined ? {} : { branch: branchName }),
    };
  });
}
