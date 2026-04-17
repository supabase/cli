// Patterns for dynamic values that should be replaced with stable placeholders
// when recording and replaying.

const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const ISO_TIMESTAMP_PATTERN = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/g;
// Matches any Bearer token — JWT style (a.b.c) or opaque (sbp_..., etc.)
const BEARER_TOKEN_PATTERN = /Bearer\s+[A-Za-z0-9._-]+/g;
// Matches bare JWTs in response bodies (always start with eyJ = base64url of '{"')
const JWT_PATTERN = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;
// Matches Supabase publishable and secret API keys
const SUPABASE_KEY_PATTERN = /sb_(?:publishable|secret)_[A-Za-z0-9_-]+/g;

// A fixed valid ISO 8601 timestamp used in place of real timestamps so that
// CLI code that calls time.Parse on response fields doesn't fail.
const FIXED_TIMESTAMP = "2000-01-01T00:00:00Z";

/** Replace dynamic values in a string with stable, unnumbered placeholders.
 *  Timestamps become a fixed valid ISO string so CLIs that parse them don't fail. */
export function applyPlaceholders(input: string): { output: string } {
  let output = input;
  // Bearer tokens first (before JWT/ref patterns consume sub-parts)
  output = output.replace(BEARER_TOKEN_PATTERN, "Bearer <ACCESS_TOKEN>");
  output = output.replace(JWT_PATTERN, "<JWT>");
  output = output.replace(SUPABASE_KEY_PATTERN, "<API_KEY>");
  output = output.replace(UUID_PATTERN, "<UUID>");
  // 20-char lowercase alpha strings — project refs
  output = output.replace(/\b[a-z]{20}\b/g, (match) =>
    match.length !== 20 ? match : "<PROJECT_REF>",
  );
  output = output.replace(ISO_TIMESTAMP_PATTERN, FIXED_TIMESTAMP);
  return { output };
}

/** Normalize dynamic segments in a URL path to stable unnumbered placeholders.
 *  Apply this to both the stored fixture path and the incoming request path so
 *  both sides of a scenario comparison transform identically. */
export function normalizeUrlPath(urlPath: string): string {
  return urlPath.replace(UUID_PATTERN, "<UUID>").replace(/\/[a-z]{20}(\/|$)/g, "/<PROJECT_REF>$1");
}

/** Normalize a URL path for use as a fixture directory key. */
function normalizePath(urlPath: string): string {
  return normalizeUrlPath(urlPath)
    .replace(/^\//, "")
    .replace(/[/-]/g, "_")
    .replace(/[^a-zA-Z0-9_<>]/g, "_");
}

/** Build the fixture directory key from method and path. */
export function fixtureKey(method: string, urlPath: string): string {
  return `${method.toUpperCase()}_${normalizePath(urlPath)}`;
}
