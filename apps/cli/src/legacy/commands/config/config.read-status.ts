import { legacySanitizeInlineName } from "../../shared/legacy-http-errors.ts";

/**
 * The generic status-message shape every Management API status check in the
 * `config` command family falls back to when it has no purpose-written
 * message for the status it received (including the six per-resource update
 * requests `config push` makes, and the branch-resolution lookup `config
 * diff`/`config pull` share).
 */
export function legacyUnexpectedStatusMessage(status: number, body: string): string {
  return `unexpected status ${status}: ${body}`;
}

/**
 * Purpose-written messages for the status codes a wrong or inaccessible ref
 * most plausibly produces when reading `GET /v2/projects/{ref}/config` —
 * shared by `config diff`, `config pull`, and `config push`, since all three
 * read the same endpoint and a bad ref/token fails the same way for each.
 * Every other status falls back to `legacyUnexpectedStatusMessage`.
 */
export function legacyConfigReadStatusMessage(status: number, body: string, ref: string): string {
  if (status === 401) {
    return "Authentication failed: your access token is invalid or has expired. Run `supabase login` to re-authenticate.";
  }
  if (status === 403) {
    return `Access denied for project ${legacySanitizeInlineName(ref)}: your account does not have permission to view its configuration.`;
  }
  if (status === 404) {
    return `Project ${legacySanitizeInlineName(ref)} not found. Check the project ref, or run \`supabase projects list\` to see the projects you have access to.`;
  }
  return legacyUnexpectedStatusMessage(status, body);
}
