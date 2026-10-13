/**
 * Building blocks for Management API calls made by shared modules rather than command handlers.
 * A command includes the blocks its handler reaches with `compose`, adding its own condition
 * (e.g. `--linked`) with `withCondition` where the module is only used on that path.
 */

import { block } from "./model.ts";

/**
 * `DbConfigResolver` on the `--linked` path. `gen types --project-id` and `db dump`'s container
 * fallback fetch the pooler config without `--project-ref`, so those commands declare that entry
 * themselves.
 */
export const dbConfig = block(
  "db-config",
  [
    {
      operationId: "v1-create-login-role",
      kind: "required",
      when: [{ flag: "password", present: false }],
      context:
        "no database password in SUPABASE_DB_PASSWORD or the project .env (an ad-hoc project ref ignores both)",
    },
    {
      operationId: "v1-get-pooler-config",
      kind: "best-effort",
      when: [{ flag: "project-ref" }],
      context: "the direct database host is unreachable (IPv6-only network)",
    },
    {
      operationId: "v1-list-all-network-bans",
      kind: "best-effort",
      when: [{ flag: "password", present: false }],
      context:
        "after three failed attempts to connect through the pooler as the temporary login role",
    },
    {
      operationId: "v1-delete-network-bans",
      kind: "best-effort",
      when: [{ flag: "password", present: false }],
      context:
        "after three failed attempts to connect through the pooler as the temporary login role",
    },
  ],
  ["local", "db-url"],
);

/** `ProjectRefResolver`'s interactive picker, reached only when no ref comes from a flag, env or the linked workdir. */
export const projectRefPicker = block("project-ref", [
  {
    operationId: "v1-list-all-projects",
    kind: "required",
    when: [{ flag: "project-ref", present: false }],
    context:
      "an interactive terminal, no SUPABASE_PROJECT_ID and no supabase/.temp/project-ref (`link` ignores that file)",
  },
]);

/** `LinkedProjectCache`'s post-run fill. */
export const linkedProjectCache = block("linked-project-cache", [
  {
    operationId: "v1-get-project",
    kind: "best-effort",
    context: "no cached supabase/.temp/linked-project.json",
  },
]);

/** `linkServicesCore`, shared by `link` and `bootstrap`. */
export const linkServices = block("link-services", [
  { operationId: "v1-get-storage-config", kind: "best-effort" },
  {
    operationId: "v1-get-pooler-config",
    kind: "best-effort",
    when: [{ flag: "skip-pooler", present: false }],
  },
]);

/** `resolveStorageCredentials` for a remote project. */
export const storageCredentials = block("storage-credentials", [
  {
    operationId: "v1-get-project-api-keys",
    kind: "required",
    context: "a remote project and no SUPABASE_AUTH_SERVICE_ROLE_KEY",
    note: "Sent with reveal=true.",
  },
]);

/** `getProjectApiKeys`, shared by `projects api-keys` and `bootstrap`. */
export const projectApiKeys = block("project-api-keys", [
  {
    operationId: "v1-get-project-api-keys",
    kind: "required",
    note: "Sent with reveal=true when the caller asks for secret keys.",
  },
]);

/** `suggestUpgrade`'s entitlement lookup. */
export const upgradeSuggestion = block("upgrade-suggest", [
  {
    operationId: "v1-get-project",
    kind: "best-effort",
    context:
      "after a 4xx response that carries no plan-gate error, at a call site that names a feature",
  },
  {
    operationId: "v1-get-organization-entitlements",
    kind: "best-effort",
    context:
      "after a 4xx response that carries no plan-gate error, at a call site that names a feature",
  },
]);

/** `resolveBranchProjectRef`, for a branch argument that isn't a project ref. */
export const branchRef = block("branch-ref", [
  {
    operationId: "v1-get-a-branch-config",
    kind: "required",
    context: "the branch argument is a UUID",
  },
  {
    operationId: "v1-get-a-branch",
    kind: "required",
    context: "the branch argument is a branch name",
  },
]);

/** `findBranchName`'s branch listing. */
export const branchTarget = block("branch-target", [
  { operationId: "v1-list-all-branches", kind: "best-effort" },
]);

/** The profile lookup that stitches the account identity after login. */
export const loginProfile = block("login-profile", [
  { operationId: "v1-get-profile", kind: "best-effort" },
]);

/** `fetchLinkedServiceVersions`, behind `services`. */
export const linkedServiceVersions = block("linked-service-versions", [
  {
    operationId: "v1-get-project-api-keys",
    kind: "best-effort",
    note: "Sent with reveal=true.",
  },
  {
    operationId: "v1-get-project",
    kind: "best-effort",
    context: "the api-keys lookup returned a usable key",
  },
]);
