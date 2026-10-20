import type { V1ListAllBranchesOutput } from "@supabase/api/effect";
import { Effect, Option } from "effect";

import { CommandPlatformApiFactory } from "../../auth/command-platform-api-factory.service.ts";
import { CommandPlatformApi } from "../../auth/command-platform-api.service.ts";
import { PROJECT_REF_PATTERN } from "../../config/project-ref.service.ts";
import { Output } from "../../shared/output/output.service.ts";
import { block } from "../command-permissions/model.ts";
import {
  AUTHENTICATION_FAILED_STATUS_MESSAGE,
  mapHttpError,
  sanitizeInlineName,
} from "../http-errors.ts";
import {
  parentNotLinkedMessage,
  parentRefInvalidMessage,
  parentRefTypoHint,
  resolveLinkedParentRef,
  type ParentRefResolution,
} from "../parent-project-ref.ts";
import { BRANCH_UUID_PATTERN } from "../ref-patterns.ts";
import {
  LinkBranchListNetworkError,
  LinkBranchListStatusError,
  LinkBranchNotFoundError,
  LinkBranchNotLinkedError,
  LinkBranchNotReadyError,
  LinkParentRefInvalidError,
} from "./branch-resolution.errors.ts";
import { closestByName } from "./closest-branch.ts";
import { stripUserinfo } from "./remote-vocabulary.ts";

type Branches = typeof V1ListAllBranchesOutput.Type;
export type ParentBranch = Branches[number];

const MAX_LISTED_BRANCHES = 20;

/** The branch lookups every `--remote` value that names a branch makes. */
export const branchResolution = block("branch-resolution", [
  {
    operationId: "v1-list-all-branches",
    kind: "required",
    when: [{ selector: ["branch", "uuid"] }],
    context: "a project is linked, or the value is a branch name",
  },
  {
    operationId: "v1-get-a-branch-config",
    kind: "required",
    when: [{ selector: ["uuid"] }],
    context: "no linked project resolves, so the branch is looked up by its UUID",
  },
  {
    operationId: "v1-list-all-branches",
    kind: "required",
    when: [{ selector: ["bare"] }],
    context:
      "a bare --remote is followed by an operand that could name a branch of the linked project",
  },
]);

/** A branch resolved to its own project ref, with the parent project it was found under. */
export interface BranchResolution {
  readonly projectRef: string;
  readonly branchName: string;
  readonly parentRef: string;
  /** The project's production branch, which is the linked project itself. */
  readonly isDefault: boolean;
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

  const closest = closestByName(branches, value);
  // Sanitized like the list above — an API-provided name must not be able to inject
  // ANSI/OSC/newline controls into the terminal.
  const didYouMean =
    closest !== undefined ? ` Did you mean "${sanitizeInlineName(closest.name)}"?` : "";

  return (
    `Branch "${value}" not found for project ${parentRef}. Available branches: ${namesList}.` +
    `${didYouMean}${parentRefTypoHint(value)}`
  );
}

/** The production branch is the linked project itself. */
export const isDefaultBranch = (branch: ParentBranch, parentRef: string): boolean =>
  branch.is_default || branch.project_ref === parentRef;

/** UUID matching is case-insensitive; name matching is exact, with the not-found hint covering near misses. */
export const findBranch = (branches: Branches, value: string): ParentBranch | undefined =>
  branches.find(
    (branch) => branch.name === value || branch.id.toLowerCase() === value.toLowerCase(),
  );

const unresolvedParent = Effect.fnUntraced(function* (
  parent: Exclude<ParentRefResolution, { readonly kind: "resolved" }>,
  value: string,
) {
  return parent.kind === "absent"
    ? yield* new LinkBranchNotLinkedError({
        message: parentNotLinkedMessage(stripUserinfo(value)),
      })
    : yield* new LinkParentRefInvalidError({
        message: parentRefInvalidMessage(stripUserinfo(value)),
      });
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
const startBranchLookupTask = Effect.fnUntraced(function* (label: string) {
  const output = yield* Output;
  return output.format === "text" && output.interactive ? yield* output.task(label) : undefined;
});

const LIST_BRANCHES_FAILED = "failed to list branches: ";

/** The transport failure behind a branch-list error, without the `failed to list branches: ` lead the error message carries. */
export const listBranchesFailureCause = (error: LinkBranchListNetworkError): string => {
  const [firstLine = ""] = error.message.split("\n");
  return firstLine.startsWith(LIST_BRANCHES_FAILED)
    ? firstLine.slice(LIST_BRANCHES_FAILED.length)
    : firstLine;
};

/** What to try when the project whose branches were listed is itself a preview branch, which has none. */
export const previewBranchHint = (ref: string): string =>
  `If ${ref} is itself a preview branch, link its parent project first: supabase link --project-ref <parent-ref>`;

/** `GET /v1/projects/{ref}/branches`, shared by every branch-name lookup; no `label` means no spinner. */
const listParentBranches = Effect.fnUntraced(function* (parentRef: string, label?: string) {
  const api = yield* acquireApi();

  const mapBranchListError = mapHttpError({
    networkError: LinkBranchListNetworkError,
    statusError: LinkBranchListStatusError,
    networkMessage: (cause) => `${LIST_BRANCHES_FAILED}${cause}`,
    statusMessage: (status, body) => {
      if (status === 401) return AUTHENTICATION_FAILED_STATUS_MESSAGE;
      return status === 404
        ? `Cannot list branches for project ${parentRef} (HTTP 404). ${previewBranchHint(parentRef)}`
        : `unexpected list branches status ${status}: ${body}`;
    },
  });

  const task = label === undefined ? undefined : yield* startBranchLookupTask(label);
  const branches: Branches = yield* api.v1.listAllBranches({ ref: parentRef }).pipe(
    Effect.tapError(() => task?.fail() ?? Effect.void),
    Effect.catch(mapBranchListError),
  );
  yield* task?.clear ?? Effect.void;
  return branches;
});

type ResolvedParent = Extract<ParentRefResolution, { readonly kind: "resolved" }>;

/**
 * The branches of the parent a lookup runs under. A cached parent stands only while it lists the
 * linked project as a branch; otherwise the linked project's own branches are used, unless they
 * cannot be listed, as for a deleted branch's project, which keeps the cached parent.
 */
export const listLinkedParentBranches = Effect.fnUntraced(function* (
  parent: ResolvedParent,
  label: string,
) {
  const cached = yield* listParentBranches(parent.ref, label);
  const { linkedRef } = parent;
  if (linkedRef === undefined || cached.some((branch) => branch.project_ref === linkedRef)) {
    return { parentRef: parent.ref, branches: cached };
  }
  const own = yield* listParentBranches(linkedRef).pipe(Effect.option);
  return Option.isSome(own)
    ? { parentRef: linkedRef, branches: own.value }
    : { parentRef: parent.ref, branches: cached };
});

const resolveInParent = Effect.fnUntraced(function* (value: string, parent: ResolvedParent) {
  const { parentRef, branches } = yield* listLinkedParentBranches(parent, "Resolving branch...");
  yield* Effect.annotateCurrentSpan({
    "project.parent_ref": parentRef,
    "branch.count": branches.length,
  });

  const found = findBranch(branches, value);
  if (found === undefined) {
    return yield* new LinkBranchNotFoundError({
      message: branchNotFoundMessage(stripUserinfo(value), parentRef, branches),
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
    isDefault: isDefaultBranch(found, parentRef),
  } satisfies BranchResolution;
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
  const parent = yield* resolveLinkedParentRef();
  if (parent.kind !== "resolved") return yield* unresolvedParent(parent, value);
  return yield* resolveInParent(value, parent);
});

const resolveBranchById = Effect.fnUntraced(function* (id: string) {
  const api = yield* acquireApi();
  const notFoundMessage = `Branch "${sanitizeInlineName(id)}" not found. Run \`supabase branches list\` to see available branches.`;
  const mapBranchGetError = mapHttpError({
    networkError: LinkBranchListNetworkError,
    statusError: LinkBranchListStatusError,
    networkMessage: (cause) => `failed to look up branch: ${cause}`,
    statusMessage: (status, body) => {
      if (status === 401) return AUTHENTICATION_FAILED_STATUS_MESSAGE;
      return status === 404 ? notFoundMessage : `unexpected get branch status ${status}: ${body}`;
    },
  });

  const task = yield* startBranchLookupTask("Resolving branch...");
  const detail = yield* api.v1.getABranchConfig({ branch_id_or_ref: id }).pipe(
    Effect.tapError(() => task?.fail() ?? Effect.void),
    Effect.catch(mapBranchGetError),
    Effect.catchTag("SupabaseApiInputError", () =>
      Effect.fail(
        new LinkBranchListStatusError({ status: 404, body: "", message: notFoundMessage }),
      ),
    ),
  );
  yield* task?.clear ?? Effect.void;

  if (!PROJECT_REF_PATTERN.test(detail.ref)) {
    return yield* new LinkBranchNotReadyError({
      branch: id,
      status: detail.status,
      message: `Branch "${sanitizeInlineName(id)}" has no project ref yet (status: ${detail.status}). Wait for it to finish provisioning, then retry.`,
    });
  }
  return {
    projectRef: detail.ref,
    branchName: undefined,
    parentRef: undefined,
    // `GET /v1/branches/{id}` does not say whether this is the production branch.
    isDefault: undefined,
  };
});

/**
 * Resolves the branch a `--remote` value names: against the linked project's branches when a
 * project is linked, and a UUID with no usable link through `GET /v1/branches/{id}`.
 */
export const resolveRemoteBranchRef = Effect.fn("Target.resolveRemoteBranch")(function* (
  value: string,
) {
  const parent = yield* resolveLinkedParentRef();
  if (parent.kind === "resolved") return yield* resolveInParent(value, parent);
  if (BRANCH_UUID_PATTERN.test(value)) return yield* resolveBranchById(value);
  return yield* unresolvedParent(parent, value);
});
