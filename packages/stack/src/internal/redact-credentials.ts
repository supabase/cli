/** Decodes a query component, keeping it as is when it is not valid percent-encoding. */
export const decodeQuery = (value: string) => {
  try {
    return decodeURIComponent(value.replace(/\+/gu, " "));
  } catch {
    return value;
  }
};

/**
 * Decodes each valid percent-encoded run on its own, so a malformed escape elsewhere in the text
 * cannot hide an encoded credential delimiter; bytes that are not UTF-8 decode as Latin-1.
 */
const decodeLeniently = (value: string) =>
  value.replace(/\+/gu, " ").replace(/(?:%[\da-f]{2})+/giu, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run.replace(/%([\da-f]{2})/giu, (_, hex: string) =>
        String.fromCharCode(Number.parseInt(hex, 16)),
      );
    }
  });

/** Decodes repeatedly so a nested URL encoded more than once still exposes its delimiters. */
const decodeNested = (value: string) => {
  let current = value;
  for (let pass = 0; pass < 4; pass++) {
    const next = decodeLeniently(current);
    if (next === current) break;
    current = next;
  }
  return current;
};

// Auth puts PKCE codes, OTP token hashes and OAuth tokens in redirect and verify URLs; S3
// presigned URLs carry their SigV4 signature, credential scope and session token.
const credentialParameters = [
  "apikey",
  "jwt",
  "access_token",
  "token",
  "token_hash",
  "code",
  "refresh_token",
  "id_token",
  "provider_token",
  "provider_refresh_token",
  "x-amz-signature",
  "x-amz-credential",
  "x-amz-security-token",
];
const scheme = String.raw`[a-z][a-z\d+.-]*`;

/**
 * A decoded parameter that is a credential pair, nests one (a `redirect_to` URL carrying a
 * token), or nests a URL with userinfo.
 */
const sensitive = new RegExp(
  String.raw`(?:^|[?&#=])(?:${credentialParameters.join("|")})=|${scheme}:\/\/[^/?#@]*@`,
  "iu",
);
const userinfo = new RegExp(String.raw`^(${scheme}:\/\/)[^/?#@]*@`, "iu");

const redactPairs = (pairs: string) =>
  pairs
    .split("&")
    .map((parameter) => {
      const separator = parameter.indexOf("=");
      return separator >= 0 && sensitive.test(decodeNested(parameter))
        ? `${parameter.slice(0, separator)}=redacted`
        : parameter;
    })
    .join("&");

/**
 * Redacts an absolute URL's userinfo and credential values in its query and fragment, where
 * OAuth implicit grants put `access_token` for non-browser clients. Edits the text in place, so
 * relative and unparsable URLs work and the rest of the URL keeps its original encoding.
 */
export const redactCredentials = (url: string) => {
  const hashAt = url.indexOf("#");
  const beforeHash = hashAt < 0 ? url : url.slice(0, hashAt);
  const queryAt = beforeHash.indexOf("?");
  const base = (queryAt < 0 ? beforeHash : beforeHash.slice(0, queryAt)).replace(
    userinfo,
    "$1redacted@",
  );
  const query = queryAt < 0 ? "" : `?${redactPairs(beforeHash.slice(queryAt + 1))}`;
  const fragment = hashAt < 0 ? "" : `#${redactPairs(url.slice(hashAt + 1))}`;
  return `${base}${query}${fragment}`;
};
