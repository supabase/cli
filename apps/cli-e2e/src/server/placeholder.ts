// Patterns for dynamic values that should be replaced with stable placeholders
// when recording and replaying.

const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
// Docker container/image IDs — 64-char lowercase hex (distinct from UUIDs which have dashes).
// Must run before the 20-char project-ref pattern since container IDs also satisfy [a-z0-9]{20}.
const DOCKER_SHA256_PATTERN = /\bsha256:[0-9a-f]{64}\b/g;
const DOCKER_FULL_ID_PATTERN = /\b[0-9a-f]{64}\b/g;
const ISO_TIMESTAMP_PATTERN = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/g;
// Matches any Bearer token — JWT style (a.b.c) or opaque (sbp_..., etc.)
const BEARER_TOKEN_PATTERN = /Bearer\s+[A-Za-z0-9._-]+/g;
// Matches bare JWTs in response bodies (always start with eyJ = base64url of '{"')
const JWT_PATTERN = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;
// Matches Supabase publishable and secret API keys
const SUPABASE_KEY_PATTERN = /sb_(?:publishable|secret)_[A-Za-z0-9_-]+/g;
// Matches the local replay server host header (127.0.0.1 or localhost with a dynamic port)
const LOCAL_HOST_PORT_PATTERN = /(?:127\.0\.0\.1|localhost):\d+/g;
// Rate limit headers: both change every recording session (countdown timer and quota counter).
// Normalise to fixed valid integers so the CLI can still parse them for retry logic.
const RATE_LIMIT_RESET_PATTERN = /"x-ratelimit-reset": "\d+"/g;
const RATE_LIMIT_REMAINING_PATTERN = /"x-ratelimit-remaining": "\d+"/g;
// API key hash — SHA-256 base64url, rotates when the test project keys are recreated.
const API_KEY_HASH_PATTERN = /"hash": "[A-Za-z0-9_-]+"/g;
// Legacy API key prefix — 5-char alphanumeric, rotates with the key.
// Must run after SUPABASE_KEY_PATTERN so new-style key prefixes are already "<API_KEY>".
const LEGACY_KEY_PREFIX_PATTERN = /"prefix": "[A-Za-z0-9]{4,10}"/g;
// Integer IDs from DB auto-increment (project internal ID, SSO provider ID, etc.).
// Only targets 4+ digit integers to avoid touching small status codes or counts.
const INTEGER_ID_PATTERN = /"id": \d{4,}/g;

// A fixed valid ISO 8601 timestamp used in place of real timestamps so that
// CLI code that calls time.Parse on response fields doesn't fail.
const FIXED_TIMESTAMP = "2000-01-01T00:00:00Z";

/** Replace dynamic values in a string with stable, unnumbered placeholders.
 *  Timestamps become a fixed valid ISO string so CLIs that parse them don't fail. */
export function applyPlaceholders(input: string): { output: string } {
  let output = input;
  output = output.replace(LOCAL_HOST_PORT_PATTERN, "localhost:<PORT>");
  // Bearer tokens first (before JWT/ref patterns consume sub-parts)
  output = output.replace(BEARER_TOKEN_PATTERN, "Bearer <ACCESS_TOKEN>");
  output = output.replace(JWT_PATTERN, "<JWT>");
  output = output.replace(SUPABASE_KEY_PATTERN, "<API_KEY>");
  output = output.replace(UUID_PATTERN, "<UUID>");
  // Docker IDs — normalize before the 20-char project-ref pattern fires on sub-matches.
  output = output.replace(DOCKER_SHA256_PATTERN, "sha256:<IMAGE_ID>");
  output = output.replace(DOCKER_FULL_ID_PATTERN, "<CONTAINER_ID>");
  // 20-char lowercase alpha strings — project refs
  output = output.replace(/\b[a-z]{20}\b/g, (match) =>
    match.length !== 20 ? match : "<PROJECT_REF>",
  );
  output = output.replace(ISO_TIMESTAMP_PATTERN, FIXED_TIMESTAMP);
  // Rate limit headers vary per recording session — normalise to fixed valid integers.
  output = output.replace(RATE_LIMIT_RESET_PATTERN, '"x-ratelimit-reset": "60"');
  output = output.replace(RATE_LIMIT_REMAINING_PATTERN, '"x-ratelimit-remaining": "119"');
  // API key hash and legacy prefix rotate when keys are recreated.
  output = output.replace(API_KEY_HASH_PATTERN, '"hash": "<KEY_HASH>"');
  output = output.replace(LEGACY_KEY_PREFIX_PATTERN, '"prefix": "<KEY_PREFIX>"');
  // DB auto-increment IDs change every time a resource is created.
  output = output.replace(INTEGER_ID_PATTERN, '"id": 1');
  return { output };
}

/** Normalize dynamic segments in a URL path to stable unnumbered placeholders.
 *  Apply this to both the stored fixture path and the incoming request path so
 *  both sides of a scenario comparison transform identically. */
export function normalizeUrlPath(urlPath: string): string {
  return (
    urlPath
      .replace(UUID_PATTERN, "<UUID>")
      .replace(/\/[a-z]{20}(\/|$)/g, "/<PROJECT_REF>$1")
      // Docker API version (/v1.47/ → /<DOCKER_VERSION>/) so fixture keys are
      // stable across minor Docker Engine upgrades that bump the negotiated API version.
      .replace(/\/v1\.\d+(\/|$)/g, "/<DOCKER_VERSION>$1")
      // Docker container/image IDs in URL paths (64-char lowercase hex) — collapse
      // to a single fixture key so each container does not produce its own dir.
      .replace(/\/[0-9a-f]{64}(\/|$)/g, "/<CONTAINER_ID>$1")
  );
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
