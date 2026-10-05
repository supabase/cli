import { backupsPermissions } from "../../commands/backups/backups.permissions.ts";
import { bootstrapPermissions } from "../../commands/bootstrap/bootstrap.permissions.ts";
import { branchesPermissions } from "../../commands/branches/branches.permissions.ts";
import { completionPermissions } from "../../commands/completion/completion.permissions.ts";
import { computePermissions } from "../../commands/experimental/compute/compute.permissions.ts";
import { configPermissions } from "../../commands/config/config.permissions.ts";
import { dbPermissions } from "../../commands/db/db.permissions.ts";
import { domainsPermissions } from "../../commands/domains/domains.permissions.ts";
import { encryptionPermissions } from "../../commands/encryption/encryption.permissions.ts";
import { feedbackPermissions } from "../../commands/feedback/feedback.permissions.ts";
import { functionsPermissions } from "../../commands/functions/functions.permissions.ts";
import { genPermissions } from "../../commands/gen/gen.permissions.ts";
import { initPermissions } from "../../commands/init/init.permissions.ts";
import { inspectPermissions } from "../../commands/inspect/inspect.permissions.ts";
import { issuePermissions } from "../../commands/issue/issue.permissions.ts";
import { linkPermissions } from "../../commands/link/link.permissions.ts";
import { loginPermissions } from "../../commands/login/login.permissions.ts";
import { logoutPermissions } from "../../commands/logout/logout.permissions.ts";
import { migrationPermissions } from "../../commands/migration/migration.permissions.ts";
import { networkBansPermissions } from "../../commands/network-bans/network-bans.permissions.ts";
import { networkRestrictionsPermissions } from "../../commands/network-restrictions/network-restrictions.permissions.ts";
import { notebooksPermissions } from "../../commands/notebooks/notebooks.permissions.ts";
import { orgsPermissions } from "../../commands/orgs/orgs.permissions.ts";
import { postgresConfigPermissions } from "../../commands/postgres-config/postgres-config.permissions.ts";
import { projectsPermissions } from "../../commands/projects/projects.permissions.ts";
import { pullPermissions } from "../../commands/pull/pull.permissions.ts";
import { secretsPermissions } from "../../commands/secrets/secrets.permissions.ts";
import { seedPermissions } from "../../commands/seed/seed.permissions.ts";
import { servicesPermissions } from "../../commands/services/services.permissions.ts";
import { snippetsPermissions } from "../../commands/snippets/snippets.permissions.ts";
import { sslEnforcementPermissions } from "../../commands/ssl-enforcement/ssl-enforcement.permissions.ts";
import { ssoPermissions } from "../../commands/sso/sso.permissions.ts";
import { stackPermissions } from "../../commands/experimental/stack/stack.permissions.ts";
import { startPermissions } from "../../commands/start/start.permissions.ts";
import { statusPermissions } from "../../commands/status/status.permissions.ts";
import { stopPermissions } from "../../commands/stop/stop.permissions.ts";
import { storagePermissions } from "../../commands/storage/storage.permissions.ts";
import { telemetryPermissions } from "../../commands/telemetry/telemetry.permissions.ts";
import { testPermissions } from "../../commands/test/test.permissions.ts";
import { unlinkPermissions } from "../../commands/unlink/unlink.permissions.ts";
import { vanitySubdomainsPermissions } from "../../commands/vanity-subdomains/vanity-subdomains.permissions.ts";
import { whoamiPermissions } from "../../commands/whoami/whoami.permissions.ts";
import type {
  CommandPermissions,
  FlagCondition,
  OperationEntry,
  PermissionGroup,
} from "./model.ts";

/**
 * Every command group's permission module, keyed by its top-level command word (not its source
 * directory — `compute` and `stack` live under `commands/experimental/`, but are invoked as
 * `supabase compute …` / `supabase stack …`). `command-permissions.unit.test.ts` walks the real
 * command tree and checks this set against it, so an added or removed group fails that test
 * instead of silently going unmapped.
 */
export const PERMISSION_GROUPS: ReadonlyMap<string, PermissionGroup> = new Map([
  ["backups", backupsPermissions],
  ["bootstrap", bootstrapPermissions],
  ["branches", branchesPermissions],
  ["completion", completionPermissions],
  ["compute", computePermissions],
  ["config", configPermissions],
  ["db", dbPermissions],
  ["domains", domainsPermissions],
  ["encryption", encryptionPermissions],
  ["feedback", feedbackPermissions],
  ["functions", functionsPermissions],
  ["gen", genPermissions],
  ["init", initPermissions],
  ["inspect", inspectPermissions],
  ["issue", issuePermissions],
  ["link", linkPermissions],
  ["login", loginPermissions],
  ["logout", logoutPermissions],
  ["migration", migrationPermissions],
  ["network-bans", networkBansPermissions],
  ["network-restrictions", networkRestrictionsPermissions],
  ["notebooks", notebooksPermissions],
  ["orgs", orgsPermissions],
  ["postgres-config", postgresConfigPermissions],
  ["projects", projectsPermissions],
  ["pull", pullPermissions],
  ["secrets", secretsPermissions],
  ["seed", seedPermissions],
  ["services", servicesPermissions],
  ["snippets", snippetsPermissions],
  ["ssl-enforcement", sslEnforcementPermissions],
  ["sso", ssoPermissions],
  ["stack", stackPermissions],
  ["start", startPermissions],
  ["status", statusPermissions],
  ["stop", stopPermissions],
  ["storage", storagePermissions],
  ["telemetry", telemetryPermissions],
  ["test", testPermissions],
  ["unlink", unlinkPermissions],
  ["vanity-subdomains", vanitySubdomainsPermissions],
  ["whoami", whoamiPermissions],
]);

function buildCommandPermissions(): ReadonlyMap<string, CommandPermissions> {
  const merged = new Map<string, CommandPermissions>();
  for (const [group, permissions] of PERMISSION_GROUPS) {
    for (const [path, commandPermissions] of permissions.declared) {
      if (path.split(" ")[0] !== group) {
        throw new Error(
          `command-permissions/index.ts: "${path}" is declared in the "${group}" group file, but its first word doesn't match — move it to the right group's <group>.permissions.ts.`,
        );
      }
      merged.set(path, commandPermissions);
    }
  }
  return merged;
}

/** Every declared command's permissions, merged across every group. */
export const COMMAND_PERMISSIONS: ReadonlyMap<string, CommandPermissions> =
  buildCommandPermissions();

/** Every leaf command path still awaiting a permission mapping, merged across every group. */
export const PENDING_COMMANDS: ReadonlyArray<string> = [...PERMISSION_GROUPS.values()].flatMap(
  (group) => group.pending,
);

function conditionHolds(condition: FlagCondition, activeFlags: ReadonlyArray<string>): boolean {
  return activeFlags.includes(condition.flag) === (condition.present ?? true);
}

/** Higher wins a dedupe conflict: a required check with no `context` must never lose to one that has one. */
function dedupeRank(entry: OperationEntry): number {
  if (entry.kind === "best-effort") return 0;
  return entry.context === undefined ? 2 : 1;
}

/** Dedupes entries sharing an `operationId`, keeping the higher-ranked one on a conflict (see {@link dedupeRank}). */
function dedupeOperations(
  operations: ReadonlyArray<OperationEntry>,
): ReadonlyArray<OperationEntry> {
  const byId = new Map<string, OperationEntry>();
  for (const entry of operations) {
    const existing = byId.get(entry.operationId);
    if (existing === undefined || dedupeRank(entry) > dedupeRank(existing)) {
      byId.set(entry.operationId, entry);
    }
  }
  return [...byId.values()];
}

type MappedCommandPermissions = Extract<CommandPermissions, { status: "mapped" }>;

/** The entries of `permissions` that apply under `activeFlags`, deduped by `operationId`. */
export function applicableOperations(
  permissions: MappedCommandPermissions,
  activeFlags: ReadonlyArray<string>,
): ReadonlyArray<OperationEntry> {
  const applicable = permissions.operations.filter(
    (entry) =>
      entry.when === undefined || entry.when.every((cond) => conditionHolds(cond, activeFlags)),
  );
  return dedupeOperations(applicable);
}

/**
 * The permission entries that apply to `path` under `activeFlags`, with building blocks already
 * merged in by whatever `compose`d the command's own declaration. Returns `undefined` when `path`
 * has no declared mapping — still `pending`, or not a real command path at all; callers (notably
 * `tests/helpers/permission-drift.ts`) should treat that as a hard failure, not an empty answer.
 */
export function permissionsFor(
  path: string,
  activeFlags: ReadonlyArray<string> = [],
): CommandPermissions | undefined {
  const declared = COMMAND_PERMISSIONS.get(path);
  if (declared === undefined) return undefined;
  if (declared.status === "unmapped") return declared;
  return {
    status: "mapped",
    operations: applicableOperations(declared, activeFlags),
    noApiEffectFlags: declared.noApiEffectFlags,
  };
}
