import type { V1ListAllBranchesOutput } from "@supabase/api/effect";
import { Effect, Option } from "effect";

import { CommandPlatformApiFactory } from "../../auth/command-platform-api-factory.service.ts";
import { CommandPlatformApi } from "../../auth/command-platform-api.service.ts";
import { PROJECT_REF_PATTERN } from "../../config/project-ref.service.ts";
import { Output } from "../../shared/output/output.service.ts";
import { block } from "../command-permissions/model.ts";
import { mapHttpError, sanitizeInlineName } from "../http-errors.ts";
import {
  parentNotLinkedMessage,
  parentRefInvalidMessage,
  parentRefTypoHint,
  resolveLinkedParentRef,
} from "../parent-project-ref.ts";
import {
  LinkBranchListNetworkError,
  LinkBranchListStatusError,
  LinkBranchNotFoundError,
  LinkBranchNotLinkedError,
  LinkBranchNotReadyError,
  LinkParentRefInvalidError,
} from "./branch-resolution.errors.ts";

type Branches = typeof V1ListAllBranchesOutput.Type;
export type ParentBranch = Branches[number];

const MAX_LISTED_BRANCHES = 20;

const BRANCH_LOOKUP_CONTEXT =
  "the value is neither a 20-letter project ref nor a database URL (a branch name or UUID), or a bare --remote is followed by a word that could name a branch";

/** The branch listing every branch-name lookup makes against the linked project. */
export const branchResolution = block("branch-resolution", [
  {
    operationId: "v1-list-all-branches",
    kind: "required",
    when: [{ flag: "remote", present: true }],
    context: BRANCH_LOOKUP_CONTEXT,
  },
  {
    operationId: "v1-list-all-branches",
    kind: "required",
    when: [{ flag: "project-ref", present: true }],
    context: BRANCH_LOOKUP_CONTEXT,
  },
]);

/** A branch resolved to its own project ref, with the parent project it was found under. */
export interface BranchResolution {
  readonly projectRef: string;
  readonly branchName: string;
  readonly parentRef: string;
}

function branchNotFoundMessage(value: string, parentRef: string, branches: Branches): string {
  if (branches.length === 0) {
    return `Branch "${value}" not found: project ${parentRef} has no branches.${parentRefTypoHint(value)}`;
  }

  const sortedNames = branches.map((branch) => branch.name).toSorted();
  const shown = sortedNames.slice(0, MAX_LISTED_BRANCHES);
  const remaining = sortedNames.length - shown.length;
  // Branch names are API-provided; sanitize them the same way response bodies are before
  // embedding them in an error message.
  const shownSanitized = sanitizeInlineName(shown.join(", "));
  const namesList =
    remaining > 0
      ? `${shownSanitized}, … (${remaining} more — run supabase branches list)`
      : shownSanitized;

  const trimmedLower = value.trim().toLowerCase();
  const nearMiss = branches.find((branch) => branch.name.toLowerCase() === trimmedLower);
  // Sanitized like the list above — an API-provided name must not be able to inject
  // ANSI/OSC/newline controls into the terminal.
  const didYouMean =
    nearMiss !== undefined ? ` Did you mean "${sanitizeInlineName(nearMiss.name)}"?` : "";

  return (
    `Branch "${value}" not found for project ${parentRef}. Available branches: ${namesList}` +
    `${didYouMean}${parentRefTypoHint(value)}`
  );
}

/** UUID matching is case-insensitive; name matching is exact, with the not-found hint covering near misses. */
export const findBranch = (branches: Branches, value: string): ParentBranch | undefined =>
  branches.find(
    (branch) => branch.name === value || branch.id.toLowerCase() === value.toLowerCase(),
  );

/** The linked parent project's ref, searched for a branch named `value`. */
const resolveBranchParentRef = Effect.fnUntraced(function* (value: string) {
  const parent = yield* resolveLinkedParentRef();
  if (parent.kind === "absent") {
    return yield* new LinkBranchNotLinkedError({ message: parentNotLinkedMessage(value) });
  }
  if (parent.kind === "invalid") {
    return yield* new LinkParentRefInvalidError({ message: parentRefInvalidMessage(value) });
  }
  return parent.ref;
});

/** The eager client when the command built one, else the lazy factory's, so a bare run never resolves a token. */
const acquireApi = Effect.fnUntraced(function* () {
  const direct = yield* Effect.serviceOption(CommandPlatformApi);
  if (Option.isSome(direct)) return direct.value;
  const factory = yield* Effect.serviceOption(CommandPlatformApiFactory);
  if (Option.isNone(factory)) {
    return yield* Effect.die(
      new Error("a branch lookup needs CommandPlatformApi or CommandPlatformApiFactory"),
    );
  }
  return yield* factory.value.make;
});

/** A branch-lookup spinner, shown only on a terminal: a non-terminal text run writes task steps to stdout, which may carry the command's payload. */
export const startBranchLookupTask = Effect.fnUntraced(function* (label: string) {
  const output = yield* Output;
  return output.format === "text" && output.interactive ? yield* output.task(label) : undefined;
});

/** `GET /v1/projects/{ref}/branches`, shared by every branch-name lookup. */
export const listParentBranches = Effect.fnUntraced(function* (parentRef: string, label: string) {
  const api = yield* acquireApi();

  const mapBranchListError = mapHttpError({
    networkError: LinkBranchListNetworkError,
    statusError: LinkBranchListStatusError,
    networkMessage: (cause) => `failed to list branches: ${cause}`,
    statusMessage: (status, body) =>
      status === 404
        ? `Cannot list branches for project ${parentRef} (HTTP 404). If ${parentRef} is itself a preview branch, link its parent project first: supabase link --project-ref <parent-ref>`
        : `unexpected list branches status ${status}: ${body}`,
  });

  const task = yield* startBranchLookupTask(label);
  const branches: Branches = yield* api.v1.listAllBranches({ ref: parentRef }).pipe(
    Effect.tapError(() => task?.fail() ?? Effect.void),
    Effect.catch(mapBranchListError),
  );
  yield* task?.clear ?? Effect.void;
  return branches;
});

/**
 * Resolves a non-ref-shaped value to the branch's project ref by looking it up (by name or UUID)
 * against the linked parent project's branches. A ref-shaped value (20 lowercase letters) is
 * always a ref and never looked up as a branch name.
 *
 * Uses the list endpoint rather than a single-branch lookup so the full list can power the
 * available-branches error.
 */
export const resolveLinkBranchRef = Effect.fn("Target.resolveBranch")(function* (value: string) {
  const parentRef = yield* resolveBranchParentRef(value);
  const branches = yield* listParentBranches(parentRef, "Resolving branch...");
  yield* Effect.annotateCurrentSpan({
    "project.parent_ref": parentRef,
    "branch.count": branches.length,
  });

  const found = findBranch(branches, value);
  if (found === undefined) {
    return yield* new LinkBranchNotFoundError({
      message: branchNotFoundMessage(value, parentRef, branches),
    });
  }

  if (!PROJECT_REF_PATTERN.test(found.project_ref)) {
    return yield* new LinkBranchNotReadyError({
      branch: found.name,
      status: found.status,
      message: `Branch "${sanitizeInlineName(found.name)}" has no project ref yet (status: ${found.status}). Wait for it to finish provisioning, then retry.`,
    });
  }

  return {
    projectRef: found.project_ref,
    branchName: found.name,
    parentRef,
  } satisfies BranchResolution;
});
