import {
  applicableOperations,
  COMMAND_PERMISSIONS,
} from "../../src/command-internal/command-permissions/registry.ts";
import { GLOBAL_NO_API_EFFECT_FLAGS } from "../../src/command-internal/command-permissions/global-flags.ts";
import type { CommandPermissions } from "../../src/command-internal/command-permissions/model.ts";
import { matchOperation } from "./operation-table.ts";

export interface RecordedMethodUrl {
  readonly method: string;
  readonly url: string;
}

export interface AssertPermissionDriftOptions {
  /** The declared command path, e.g. `"secrets list"`. */
  readonly command: string;
  /** Flags active in this test run (without the leading `--`), e.g. `["linked"]`. */
  readonly activeFlags?: ReadonlyArray<string>;
  readonly requests: ReadonlyArray<RecordedMethodUrl>;
  /**
   * The happy-path check: every `required` entry that applies under `activeFlags` (and carries
   * no `context`) must have been requested. Leave unset for tests that only exercise part of a
   * command's calls.
   */
  readonly exact?: boolean;
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
 * Fails with a descriptive message when a recorded request diverges from `command`'s declared
 * permission mapping:
 * - `activeFlags` names something `command`'s own declaration never classifies (likely a typo);
 * - an in-scope request matches no known Management API operation (a path-template typo or a
 *   missing spec entry — not something to silently ignore);
 * - the matched operation is declared for `command` but its `when` doesn't hold for
 *   `activeFlags` — check that `activeFlags` matches what this test run actually exercises;
 * - the matched operation isn't declared for `command` at all, building blocks included;
 * - with `exact: true`, a declared `required` entry that applies under `activeFlags` was never
 *   requested.
 *
 * Out-of-scope requests (not a Management API call — see `operation-table.ts`) are ignored.
 *
 * Known gap: a call a test mocks away entirely (e.g. a layer replaced wholesale, as integration
 * tests do with `DbConfigResolver`) never reaches `requests`, so this can't catch drift there —
 * those calls need their own building-block test instead.
 */
export function assertPermissionDrift(options: AssertPermissionDriftOptions): void {
  const { command, requests, exact = false } = options;
  const activeFlags = options.activeFlags ?? [];
  const declared = COMMAND_PERMISSIONS.get(command);
  if (declared === undefined) {
    throw new Error(
      `assertPermissionDrift: no permission mapping declared for command "${command}" — map it in its <command>.permissions.ts before asserting drift.`,
    );
  }
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
    const match = matchOperation(request.method, request.url);
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
