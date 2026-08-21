/** Environment-only live-suite configuration. */

export const LIVE_EXIT_TIMEOUT_MS = 240_000;

export function liveApiUrl(): string {
  const value = process.env["SUPABASE_LIVE_API_URL"]?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error("SUPABASE_LIVE_API_URL is required to run the live suite");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`SUPABASE_LIVE_API_URL must be an absolute HTTP(S) URL: ${value}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`SUPABASE_LIVE_API_URL must use http:// or https://: ${value}`);
  }
  return url.toString().replace(/\/+$/u, "");
}

export function liveAccessToken(): string {
  const token = process.env["SUPABASE_ACCESS_TOKEN"]?.trim();
  if (token === undefined || token.length === 0) {
    throw new Error("SUPABASE_ACCESS_TOKEN is required to run the live suite");
  }
  return token;
}

export function validateLiveConfig(): { readonly apiUrl: string; readonly accessToken: string } {
  return { apiUrl: liveApiUrl(), accessToken: liveAccessToken() };
}

export function keepLiveProject(): boolean {
  return process.env["SUPABASE_LIVE_KEEP_PROJECT"] === "1";
}

export function liveProjectName(): string {
  return process.env["SUPABASE_LIVE_PROJECT_NAME"]?.trim() || "supabase-cli-live";
}

export function liveRegion(): string {
  return process.env["SUPABASE_LIVE_REGION"]?.trim() || "us-east-1";
}

export function liveOrgId(): string | undefined {
  const value = process.env["SUPABASE_LIVE_ORG_ID"]?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
}

/** Resolve `<ref>.<host>` from a database host such as `db.<ref>.supabase.co`. */
export function deriveLiveProjectHost(databaseHost: string, projectRef: string): string {
  const prefix = `db.${projectRef}.`;
  if (!databaseHost.startsWith(prefix)) {
    throw new Error(
      `Cannot derive project host for ${projectRef} from database host ${databaseHost}; expected a ${prefix}<host> name`,
    );
  }
  const host = databaseHost.slice(prefix.length);
  if (host.length === 0 || host.includes("/")) {
    throw new Error(`Cannot derive a valid project host from database host ${databaseHost}`);
  }
  return host;
}
