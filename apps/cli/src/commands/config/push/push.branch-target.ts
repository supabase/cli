import { Data, Effect, FileSystem, Option, Path } from "effect";
import * as HttpClientError from "effect/http/HttpClientError";

import { CommandPlatformApi } from "../../../auth/command-platform-api.service.ts";
import { CommandSettings } from "../../../config/command-settings.service.ts";
import { BRANCH_LOOKUP_TIMEOUT, findBranchName } from "../../../command-internal/branch-target.ts";
import { BRANCH_PROJECT_REF_PATTERN } from "../../../command-internal/ref-patterns.ts";
import { readLinkSnapshotSoft } from "../../../shared/config/link-snapshot.ts";
import { Output } from "../../../shared/output/output.service.ts";

/**
 * What `ref` is for `config push`'s payload: the linked or production `"project"`, a confirmed
 * preview `"branch"` (`parentRef`/`branch` present only when known), or `"unknown"` when nothing
 * could settle it, which the payload asserts as neither.
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
 * What the caller knows about the `--remote` branch `ref` came from, so
 * {@link resolveConfigPushTarget} skips the live probe: a `"name"` (parent known), a `"uuid"`
 * (certainly a branch; the parent is recovered best-effort), the `"production"` default branch
 * (the project itself) or an `"unverified"` UUID (says nothing about `ref`).
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
 * Resolves what `ref` is so `config push` can tell a branch from the linked project. Never fails,
 * since this diagnostic must not abort a push: `GET /v1/projects/{ref}` (bounded at
 * {@link BRANCH_LOOKUP_TIMEOUT}) is a project on 200, `"unknown"` on any other failure, and on a
 * 404 recovers the parent and name from the link when they can be trusted.
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
    const readSnapshot = readLinkSnapshotSoft(fs, path, cliSettings.workdir);
    const readCachedParent = readSnapshot.pipe(Effect.map((snapshot) => snapshot.parent));

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
    // the linked ref only once there's a cache candidate to correlate it against, so the
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

    const fileRef = (yield* readSnapshot).ref;
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
