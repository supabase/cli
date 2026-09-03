import { legacySanitizeInlineName } from "../../shared/legacy-http-errors.ts";

const readStatusMessage = (status: number, body: string) => `unexpected status ${status}: ${body}`;

/**
 * Purpose-written messages for the config-read status codes a wrong or
 * inaccessible ref most plausibly produces; every other status keeps the
 * generic `unexpected status N: body` shape. TS-only surface (no Go
 * counterpart for this endpoint).
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
  return readStatusMessage(status, body);
}
