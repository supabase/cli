import {
  applicableOperations,
  declaredPermissions,
} from "../../src/command-internal/command-permissions/registry.ts";
import type {
  DeclaredPermissionsLookup,
  PermissionVariant,
} from "../../src/command-internal/command-permissions/registry.ts";
import { GLOBAL_NO_API_EFFECT_FLAGS } from "../../src/command-internal/command-permissions/global-flags.ts";
import type { CommandPermissions } from "../../src/command-internal/command-permissions/model.ts";
import { matchOperation } from "./operation-table.ts";

export interface RecordedMethodUrl {
  readonly method: string;
  readonly url: string;
}

export interface DriftCheckOptions {
  /** The declared command path, e.g. `"secrets list"`. */
  readonly command: string;
  /** Flags active in this test run (without the leading `--`), e.g. `["linked"]`. */
  readonly activeFlags?: ReadonlyArray<string>;
  readonly requests: ReadonlyArray<RecordedMethodUrl>;
  /** The Management API base URL the requests were recorded against; defaults to `https://api.supabase.com`. */
  readonly apiUrl?: string;
  /**
   * The happy-path check: every `required` entry that applies under `activeFlags` (and carries
   * no `context`) must have been requested. Leave unset for tests that only exercise part of a
   * command's calls.
   */
  readonly exact?: boolean;
}

export interface AssertPermissionDriftOptions extends DriftCheckOptions {
  /** The command tree to look `command` up in; defaults to the default root (`start`/`status`/`stop` differ by stack backend). */
  readonly variant?: PermissionVariant;
}

/** Every flag name `command`'s declaration classifies anywhere — a global, a no-effect flag, or a `when` condition. */
function knownFlagNames(
  permissions: Extract<CommandPermissions, { status: "mapped" }>,
): Set<string> {
  const names = new Set(GLOBAL_NO_API_EFFECT_FLAGS);
  for (const flag of permissions.noApiEffectFlags) names.add(flag);
  for (const entry of permissions.operations) {
    for (const cond of entry.when ?? []) names.add(cond.flag);
  }
  return names;
}

/**
 * Fails when a recorded Management API request diverges from `command`'s declared permissions.
 * Calls a test mocks away entirely (a layer replaced wholesale) never reach `requests`, so they
 * need their own building-block test.
 */
export function assertPermissionDrift(options: AssertPermissionDriftOptions): void {
  assertDriftAgainst(declaredPermissions(options.command, options.variant), options);
}

/** {@link assertPermissionDrift} against an already-resolved lookup, so each failure branch can be exercised without a real command. */
export function assertDriftAgainst(
  lookup: DeclaredPermissionsLookup,
  options: DriftCheckOptions & { readonly variant?: PermissionVariant },
): void {
  const { command, requests, exact = false } = options;
  const activeFlags = options.activeFlags ?? [];
  if (lookup._tag === "NotFound") {
    throw new Error(
      `assertPermissionDrift: command "${command}" is not in the ${JSON.stringify(options.variant ?? "default")} command tree — pass \`variant\` if it only exists under a feature option (e.g. stack, compute).`,
    );
  }
  if (lookup._tag === "Undeclared") {
    throw new Error(
      `assertPermissionDrift: no permission mapping declared for command "${command}" — add withPermissions(...) to its <command>.command.ts before asserting drift.`,
    );
  }
  const declared = lookup.permissions;
  if (declared.status === "unmapped") {
    throw new Error(
      `assertPermissionDrift: "${command}" is declared unmapped (${declared.reason}) — it makes no CLI-side permission claims to assert drift against.`,
    );
  }

  const known = knownFlagNames(declared);
  for (const flag of activeFlags) {
    if (!known.has(flag)) {
      throw new Error(
        `assertPermissionDrift: "${command}": activeFlags names "${flag}", which this command's declaration never classifies — check for a typo.`,
      );
    }
  }

  const allDeclaredIds = new Set(declared.operations.map((entry) => entry.operationId));
  const activeEntries = applicableOperations(declared, activeFlags);
  const activeIds = new Set(activeEntries.map((entry) => entry.operationId));
  const requestedIds = new Set<string>();

  for (const request of requests) {
    const match = matchOperation(request.method, request.url, options.apiUrl);
    if (match.kind === "out-of-scope") continue;
    if (match.kind === "unmatched") {
      throw new Error(
        `assertPermissionDrift: "${command}": request ${request.method} ${match.pathname} matched no known Management API operation — check operation-table.ts and the spec.`,
      );
    }
    requestedIds.add(match.operation.operationId);
    if (activeIds.has(match.operation.operationId)) continue;
    if (allDeclaredIds.has(match.operation.operationId)) {
      throw new Error(
        `assertPermissionDrift: "${command}": request ${request.method} ${match.operation.pathTemplate} resolved to operation "${match.operation.operationId}", which is declared for this command but whose \`when\` condition doesn't hold for activeFlags=[${activeFlags.join(",")}] — check that activeFlags matches what this test run actually exercises.`,
      );
    }
    throw new Error(
      `assertPermissionDrift: "${command}": request ${request.method} ${match.operation.pathTemplate} resolved to operation "${match.operation.operationId}", which is not declared for this command at all (activeFlags=[${activeFlags.join(",")}]).`,
    );
  }

  if (!exact) return;

  const missingRequired = activeEntries.filter(
    (entry) =>
      entry.kind === "required" &&
      entry.context === undefined &&
      !requestedIds.has(entry.operationId),
  );
  if (missingRequired.length > 0) {
    throw new Error(
      `assertPermissionDrift: "${command}": exact check expected these required operations to be requested but none were: ${missingRequired.map((entry) => entry.operationId).join(", ")} (activeFlags=[${activeFlags.join(",")}]).`,
    );
  }
}
