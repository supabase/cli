import {
  AUTHENTICATION_FAILED_STATUS_MESSAGE,
  sanitizeInlineName,
  unexpectedStatusMessage,
} from "../../command-internal/http-errors.ts";

/**
 * Purpose-written messages for the status codes reading `GET /v2/projects/{ref}/config` most
 * plausibly produces, shared by `config diff`/`pull`/`push`. The 404 case also hedges on
 * `apiHost`, since a misconfigured API host may not serve this endpoint at all — and sanitizes
 * it (not guaranteed free of control characters) like `ref`, so a crafted profile can't inject
 * terminal escape sequences. Everything else falls back to `unexpectedStatusMessage`.
 */
export function configReadStatusMessage(
  status: number,
  body: string,
  ref: string,
  apiHost: string,
): string {
  if (status === 401) {
    return AUTHENTICATION_FAILED_STATUS_MESSAGE;
  }
  if (status === 403) {
    return `Access denied for project ${sanitizeInlineName(ref)}: your account does not have permission to view its configuration.`;
  }
  if (status === 404) {
    return `Could not read configuration for project ${sanitizeInlineName(ref)} (404). Check the project ref with \`supabase projects list\`; if the ref is correct, this Supabase API endpoint may not be available at ${sanitizeInlineName(apiHost)}.`;
  }
  return unexpectedStatusMessage(status, body);
}
