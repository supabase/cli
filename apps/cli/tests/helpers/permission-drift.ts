import {
  DB_TARGET_FLAGS,
  applicableEntries,
  applicableOperations,
  declaredPermissions,
} from "./permission-registry.ts";
import type {
  ActiveFlags,
  DeclaredPermissionsLookup,
  PermissionVariant,
} from "./permission-registry.ts";
import { GLOBAL_NO_API_EFFECT_FLAGS } from "./permission-global-flags.ts";
import { mapped } from "../../src/command-internal/command-permissions/model.ts";
import type {
  CommandPermissions,
  EntryCondition,
  OperationEntry,
  PermissionFragment,
} from "../../src/command-internal/command-permissions/model.ts";
import { commandTreeFor } from "./command-flags.ts";
import { matchOperation } from "./operation-table.ts";

interface RecordedMethodUrl {
  readonly method: string;
  readonly url: string;
  /** Query parameters Effect's HttpClient keeps apart from `url` (a recorded request's `urlParams`). */
  readonly urlParams?: string;
}

export interface DriftCheckOptions {
  /** The declared command path, e.g. `"secrets list"`. */
  readonly command: string;
  /** Flags this test run uses, e.g. `{ linked: true, type: "security" }` (see {@link ActiveFlags}). */
  readonly activeFlags?: ActiveFlags;
  readonly requests: ReadonlyArray<RecordedMethodUrl>;
  /** The flags `command` really accepts (its own, inherited and root globals); when set, every active flag must be among them. */
  readonly acceptedFlags?: ReadonlySet<string>;
  /** The Management API base URL the requests were recorded against; defaults to `https://api.supabase.com`. */
  readonly apiUrl?: string;
  /**
   * The happy-path check: every `required` entry that applies under `activeFlags` (and carries
   * no `context`) must have been requested. Leave unset for tests that only exercise part of a
   * command's calls.
   */
  readonly exact?: boolean;
}

export interface BlockDriftOptions extends Omit<DriftCheckOptions, "command" | "acceptedFlags"> {}

export interface AssertPermissionDriftOptions extends DriftCheckOptions {
  /** The command tree to look `command` up in; defaults to the default root (`start`/`status`/`stop` differ by stack backend). */
  readonly variant?: PermissionVariant;
}

function describeActiveFlags(activeFlags: ActiveFlags): string {
  const entries = Object.entries(activeFlags).map(([flag, value]) =>
    value === true ? flag : `${flag}=${JSON.stringify(value)}`,
  );
  return `[${entries.join(", ")}]`;
}

/** Every flag name `command`'s declaration classifies anywhere — a global, a no-effect flag, a `when` condition, or a database-target flag a condition selects on. */
function knownFlagNames(
  permissions: Extract<CommandPermissions, { status: "mapped" }>,
): Set<string> {
  const names = new Set(GLOBAL_NO_API_EFFECT_FLAGS);
  for (const flag of permissions.noApiEffectFlags) names.add(flag);
  for (const entry of permissions.operations) {
    for (const cond of entry.when ?? []) {
      if (cond.dbTarget === undefined) names.add(cond.flag);
      else for (const flag of DB_TARGET_FLAGS) names.add(flag);
    }
  }
  return names;
}

/** The query parameters a recorded request carries, whether in `url` or kept apart in `urlParams`. */
function queryOf(request: RecordedMethodUrl, apiUrl: string | undefined): URLSearchParams {
  const params = new URL(request.url, apiUrl ?? "https://api.supabase.com").searchParams;
  for (const [key, value] of new URLSearchParams(request.urlParams ?? "")) {
    params.append(key, value);
  }
  return params;
}

/**
 * A request must carry the qualifiers of at least one applicable entry for its operation, and no
 * qualifier value the declaration names for the operation without an applicable entry declaring it.
 */
function assertQualifiersMatch(
  command: string,
  request: RecordedMethodUrl,
  sent: URLSearchParams,
  applicable: ReadonlyArray<OperationEntry>,
  declaredForOperation: ReadonlyArray<OperationEntry>,
): void {
  const label = `${request.method} ${new URL(request.url, "https://api.supabase.com").pathname}`;
  if (
    !applicable.some((entry) =>
      Object.entries(entry.request?.query ?? {}).every(([key, value]) => sent.get(key) === value),
    )
  ) {
    throw new Error(
      `assertPermissionDrift: "${command}": request ${label} was sent without the query qualifiers its declaration lists (${applicable
        .map((entry) => JSON.stringify(entry.request?.query))
        .join(" or ")}).`,
    );
  }
  const mentioned = new Set(
    declaredForOperation.flatMap((entry) => Object.keys(entry.request?.query ?? {})),
  );
  for (const key of mentioned) {
    const value = sent.get(key);
    if (value !== null && !applicable.some((entry) => entry.request?.query?.[key] === value)) {
      throw new Error(
        `assertPermissionDrift: "${command}": request ${label} carries ${key}=${value}, which no applicable declaration entry lists for this operation.`,
      );
    }
  }
}

/**
 * Fails when a recorded Management API request diverges from `command`'s declared permissions.
 * Calls a test mocks away entirely (a layer replaced wholesale) never reach `requests`, so they
 * need their own building-block test.
 */
export function assertPermissionDrift(options: AssertPermissionDriftOptions): void {
  assertDriftAgainst(declaredPermissions(options.command, options.variant), {
    ...options,
    acceptedFlags:
      options.acceptedFlags ?? commandTreeFor(options.variant).get(options.command)?.flags,
  });
}

/**
 * Like {@link assertPermissionDrift}, for a building block built with `block()`: the label comes
 * from the block's `source`, so a block test names no command. Use it where the module under test
 * is the one that makes the calls.
 */
export function assertBlockDrift(fragment: PermissionFragment, options: BlockDriftOptions): void {
  const sources = new Set(fragment.operations.map((entry) => entry.source));
  const [name] = sources;
  if (sources.size !== 1 || name === undefined) {
    throw new Error(
      `assertBlockDrift: expected the result of a single block(...) call, but its entries come from ${sources.size === 0 ? "no source" : `${sources.size} sources`}.`,
    );
  }
  assertDriftAgainst(
    { _tag: "Declared", permissions: mapped(fragment) },
    { ...options, command: name, subject: "building block" },
  );
}

/** {@link assertPermissionDrift} against an already-resolved lookup, so each failure branch can be exercised without a real command. */
export function assertDriftAgainst(
  lookup: DeclaredPermissionsLookup,
  options: DriftCheckOptions & {
    readonly variant?: PermissionVariant;
    /** What `command` names in error messages; set by {@link assertBlockDrift}. */
    readonly subject?: "command" | "building block";
  },
): void {
  const { command, requests, exact = false, subject = "command" } = options;
  const label = subject === "command" ? `"${command}"` : `${subject} "${command}"`;
  const helper = subject === "command" ? "assertPermissionDrift" : "assertBlockDrift";
  const activeFlags = options.activeFlags ?? {};
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

  for (const flag of Object.keys(activeFlags)) {
    if (options.acceptedFlags !== undefined && !options.acceptedFlags.has(flag)) {
      throw new Error(
        `${helper}: ${label}: activeFlags names "${flag}", but this ${subject} does not accept --${flag} — a shared building block may mention it without the command having it.`,
      );
    }
  }

  const known = knownFlagNames(declared);
  const conditionFlags = (pick: (cond: EntryCondition) => boolean) =>
    new Set(
      declared.operations.flatMap((entry) =>
        (entry.when ?? []).flatMap((cond) =>
          cond.flag !== undefined && pick(cond) ? [cond.flag] : [],
        ),
      ),
    );
  const valueChecked = conditionFlags((cond) => cond.oneOf !== undefined);
  const switchChecked = conditionFlags((cond) => cond.is !== undefined);
  for (const flag of switchChecked) {
    // A switch the command lacks (a block's condition) can't be named, and counts as false.
    if (options.acceptedFlags !== undefined && !options.acceptedFlags.has(flag)) continue;
    if (typeof activeFlags[flag] !== "boolean") {
      throw new Error(
        `assertPermissionDrift: "${command}": a \`when\` condition checks the value of --${flag}, a switch — pass its effective value as a boolean in activeFlags (a switch defaults to false).`,
      );
    }
  }
  for (const [flag, value] of Object.entries(activeFlags)) {
    if (!known.has(flag)) {
      throw new Error(
        `${helper}: ${label}: activeFlags names "${flag}", which this ${subject}'s declaration never classifies — check for a typo.`,
      );
    }
    if (typeof value !== "string" && valueChecked.has(flag)) {
      throw new Error(
        `${helper}: ${label}: activeFlags gives "${flag}" no value, but a \`when\` condition checks its value — pass the value this run uses.`,
      );
    }
  }

  const allDeclaredIds = new Set(declared.operations.map((entry) => entry.operationId));
  const activeEntries = applicableOperations(declared, activeFlags);
  const applicableByOperation = Map.groupBy(
    applicableEntries(declared, activeFlags),
    (entry) => entry.operationId,
  );
  const declaredByOperation = Map.groupBy(declared.operations, (entry) => entry.operationId);
  const activeIds = new Set(activeEntries.map((entry) => entry.operationId));
  const requestedIds = new Set<string>();

  for (const request of requests) {
    const match = matchOperation(request.method, request.url, options.apiUrl);
    if (match.kind === "out-of-scope") continue;
    if (match.kind === "unmatched") {
      throw new Error(
        `${helper}: ${label}: request ${request.method} ${match.pathname} matched no known Management API operation — check operation-table.ts and the spec.`,
      );
    }
    requestedIds.add(match.operation.operationId);
    if (activeIds.has(match.operation.operationId)) {
      assertQualifiersMatch(
        command,
        request,
        queryOf(request, options.apiUrl),
        applicableByOperation.get(match.operation.operationId) ?? [],
        declaredByOperation.get(match.operation.operationId) ?? [],
      );
      continue;
    }
    if (allDeclaredIds.has(match.operation.operationId)) {
      throw new Error(
        `${helper}: ${label}: request ${request.method} ${match.operation.pathTemplate} resolved to operation "${match.operation.operationId}", which is declared for this ${subject} but whose \`when\` condition doesn't hold for activeFlags=${describeActiveFlags(activeFlags)} — check that activeFlags matches what this test run actually exercises, including the default value of a flag a value condition checks.`,
      );
    }
    throw new Error(
      `${helper}: ${label}: request ${request.method} ${match.operation.pathTemplate} resolved to operation "${match.operation.operationId}", which is not declared for this ${subject} at all (activeFlags=${describeActiveFlags(activeFlags)}).`,
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
      `${helper}: ${label}: exact check expected these required operations to be requested but none were: ${missingRequired.map((entry) => entry.operationId).join(", ")} (activeFlags=${describeActiveFlags(activeFlags)}).`,
    );
  }
}
