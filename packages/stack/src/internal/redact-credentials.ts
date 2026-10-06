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

/**
 * The text and up to four successive decodings of it, so a nested URL encoded more than once
 * still exposes its delimiters, and userinfo is seen before an encoded `/` in it is decoded.
 */
const decodings = (value: string) => {
  const levels = [value];
  let current = value;
  for (let pass = 0; pass < 4; pass++) {
    const next = decodeLeniently(current);
    if (next === current) break;
    levels.push(next);
    current = next;
  }
  return levels;
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
// The lookbehind starts a scheme only where a letter run begins, which keeps matching linear.
const authority = String.raw`(?<![a-z\d+.-])(?:[a-z][a-z\d+.-]*:)?\/\/`;

/**
 * A decoded parameter that is a credential pair, nests one (a `redirect_to` URL carrying a
 * token), or nests a URL with userinfo.
 */
const sensitive = new RegExp(
  String.raw`(?:^|[?&#=;])(?:${credentialParameters.join("|")})=|${authority}[^/?#]*@`,
  "iu",
);
const userinfo = new RegExp(String.raw`^(${authority})[^/?#]*@`, "iu");

const isSensitive = (text: string) => decodings(text).some((level) => sensitive.test(level));

const redactPairs = (pairs: string) =>
  pairs
    .split("&")
    .map((parameter) => {
      if (!isSensitive(parameter)) return parameter;
      const name = parameter.slice(0, Math.max(0, parameter.indexOf("=")));
      return name === "" || isSensitive(name) ? "redacted" : `${name}=redacted`;
    })
    .join("&");

/**
 * Redacts a URL's userinfo through its last `@`, and credential values in its query and
 * fragment, where OAuth implicit grants put `access_token` for non-browser clients. Edits the
 * text in place, so relative and unparsable URLs work and the rest of the URL keeps its original
 * encoding.
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
