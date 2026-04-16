// Patterns for dynamic values that should be replaced with stable placeholders
// when recording and hydrated when replaying.

const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const PROJECT_REF_PATTERN = /\b[a-z]{20}\b/g;
const ISO_TIMESTAMP_PATTERN = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/g;
// Matches any Bearer token — JWT style (a.b.c) or opaque (sbp_..., etc.)
const BEARER_TOKEN_PATTERN = /Bearer\s+[A-Za-z0-9._-]+/g;
// Matches bare JWTs in response bodies (always start with eyJ = base64url of '{"')
const JWT_PATTERN = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;
// Matches Supabase publishable and secret API keys
const SUPABASE_KEY_PATTERN = /sb_(?:publishable|secret)_[A-Za-z0-9_-]+/g;

type PlaceholderMap = Record<string, string>;

/** Replace dynamic values in a string with stable placeholders. Returns the
 *  modified string and a map of placeholder → original value for later hydration. */
export function applyPlaceholders(
  input: string,
  existingMap: PlaceholderMap = {},
): { output: string; map: PlaceholderMap } {
  const map: PlaceholderMap = { ...existingMap };
  // Reverse map for looking up existing placeholders
  const reverseMap: Record<string, string> = {};
  for (const [placeholder, original] of Object.entries(map)) {
    reverseMap[original] = placeholder;
  }

  let counter = {
    uuid: Object.keys(map).filter((k) => k.startsWith("<UUID_")).length + 1,
    ref: Object.keys(map).filter((k) => k.startsWith("<PROJECT_REF_")).length + 1,
    ts: Object.keys(map).filter((k) => k.startsWith("<TIMESTAMP_")).length + 1,
    jwt: Object.keys(map).filter((k) => k.startsWith("<JWT_")).length + 1,
    key: Object.keys(map).filter((k) => k.startsWith("<API_KEY_")).length + 1,
  };

  let output = input;

  // Replace bearer tokens first (before JWT/UUID/ref patterns)
  output = output.replace(BEARER_TOKEN_PATTERN, (match) => {
    const token = match.slice("Bearer ".length);
    if (reverseMap[token]) return `Bearer ${reverseMap[token]}`;
    const placeholder = "<ACCESS_TOKEN>";
    map[placeholder] = token;
    reverseMap[token] = placeholder;
    return `Bearer ${placeholder}`;
  });

  // Replace bare JWTs in response bodies (e.g. api_key fields)
  output = output.replace(JWT_PATTERN, (match) => {
    if (reverseMap[match]) return reverseMap[match];
    const placeholder = `<JWT_${counter.jwt++}>`;
    map[placeholder] = match;
    reverseMap[match] = placeholder;
    return placeholder;
  });

  // Replace Supabase publishable/secret API keys
  output = output.replace(SUPABASE_KEY_PATTERN, (match) => {
    if (reverseMap[match]) return reverseMap[match];
    const placeholder = `<API_KEY_${counter.key++}>`;
    map[placeholder] = match;
    reverseMap[match] = placeholder;
    return placeholder;
  });

  // Replace UUIDs
  output = output.replace(UUID_PATTERN, (match) => {
    const normalized = match.toLowerCase();
    if (reverseMap[normalized]) return reverseMap[normalized];
    const placeholder = `<UUID_${counter.uuid++}>`;
    map[placeholder] = normalized;
    reverseMap[normalized] = placeholder;
    return placeholder;
  });

  // Replace project refs (20-char lowercase alpha strings)
  output = output.replace(PROJECT_REF_PATTERN, (match) => {
    if (reverseMap[match]) return reverseMap[match];
    // Skip short common words that match the pattern but aren't refs
    if (match.length !== 20) return match;
    const placeholder = `<PROJECT_REF_${counter.ref++}>`;
    map[placeholder] = match;
    reverseMap[match] = placeholder;
    return placeholder;
  });

  // Replace timestamps
  output = output.replace(ISO_TIMESTAMP_PATTERN, (match) => {
    if (reverseMap[match]) return reverseMap[match];
    const placeholder = `<TIMESTAMP_${counter.ts++}>`;
    map[placeholder] = match;
    reverseMap[match] = placeholder;
    return placeholder;
  });

  return { output, map };
}

/** Normalize a URL path by replacing ID-like segments with placeholders.
 *  Used to build stable fixture directory keys. */
function normalizePath(urlPath: string): string {
  return (
    urlPath
      // Replace UUIDs in path segments
      .replace(UUID_PATTERN, "<UUID>")
      // Replace 20-char lowercase alpha refs (project refs)
      .replace(/\/[a-z]{20}(\/|$)/g, "/<PROJECT_REF>$1")
      // Trim leading slash and replace remaining slashes + special chars with underscores
      .replace(/^\//, "")
      .replace(/[/-]/g, "_")
      .replace(/[^a-zA-Z0-9_<>]/g, "_")
  );
}

/** Build the fixture directory key from method and path. */
export function fixtureKey(method: string, urlPath: string): string {
  return `${method.toUpperCase()}_${normalizePath(urlPath)}`;
}
