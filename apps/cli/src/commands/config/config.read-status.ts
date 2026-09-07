import { legacySanitizeInlineName } from "../../command-internal/legacy-http-errors.ts";

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
 *
 * `apiHost` (the CLI's own resolved `cliSettings.apiUrl`, not anything the
 * response body names) hedges the 404 case: `config push` is an established
 * command that used to hit six long-lived v1 endpoints, so a 404 here can
 * also mean this v2 endpoint isn't served by the configured API host at all
 * (an older self-hosted Management API, a proxy, a `SUPABASE_PROFILE`
 * pointing elsewhere) rather than a wrong project ref. `apiUrl` traces back
 * to a `SUPABASE_PROFILE` YAML file's `api_url:` value, which is validated
 * as a well-formed `http(s)://` URL but not stripped of embedded control
 * characters (`legacy-profile-load.ts` returns the raw matched string, not
 * a re-serialized one) — sanitized the same way `ref` already is, so a
 * crafted profile can't inject terminal control sequences via this message.
 */
export function legacyConfigReadStatusMessage(
  status: number,
  body: string,
  ref: string,
  apiHost: string,
): string {
  if (status === 401) {
    return "Authentication failed: your access token is invalid or has expired. Run `supabase login` to re-authenticate.";
  }
  if (status === 403) {
    return `Access denied for project ${legacySanitizeInlineName(ref)}: your account does not have permission to view its configuration.`;
  }
  if (status === 404) {
    return `Could not read configuration for project ${legacySanitizeInlineName(ref)} (404). Check the project ref with \`supabase projects list\`; if the ref is correct, this Supabase API endpoint may not be available at ${legacySanitizeInlineName(apiHost)}.`;
  }
  return legacyUnexpectedStatusMessage(status, body);
}
