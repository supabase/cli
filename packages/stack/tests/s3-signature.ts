import { DateTime, Effect } from "effect";

/** Access key pair and region an S3 client signs with. */
interface S3Credentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly region: string;
}

const encoder = new TextEncoder();

const hex = (bytes: ArrayBuffer) =>
  Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");

const sha256 = (data: Uint8Array<ArrayBuffer>) =>
  Effect.promise(() => crypto.subtle.digest("SHA-256", data));

const hmac = (key: ArrayBuffer | Uint8Array<ArrayBuffer>, data: string) =>
  Effect.promise(() =>
    crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]),
  ).pipe(
    Effect.flatMap((cryptoKey) =>
      Effect.promise(() => crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(data))),
    ),
  );

const encodeQueryPart = (value: string) =>
  encodeURIComponent(value).replace(
    /[!'()*]/gu,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );

/**
 * Returns the headers an S3 client sends for a bodyless Signature Version 4 request signed over
 * the full URL path, as clients configured with a path-prefixed endpoint do.
 */
export const signS3Request = Effect.fnUntraced(function* (input: {
  readonly method: string;
  readonly url: string;
  readonly credentials: S3Credentials;
}) {
  const url = new URL(input.url);
  const amzDate = DateTime.formatIso(yield* DateTime.now).replace(/[-:]|\.\d{3}/gu, "");
  const date = amzDate.slice(0, 8);
  const payloadHash = hex(yield* sha256(new Uint8Array()));
  const headers = {
    host: url.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  const signedHeaders = Object.keys(headers).join(";");
  const query = [...url.searchParams]
    .map(([name, value]) => `${encodeQueryPart(name)}=${encodeQueryPart(value)}`)
    .sort()
    .join("&");
  const canonicalRequest = [
    input.method,
    url.pathname,
    query,
    ...Object.entries(headers).map(([name, value]) => `${name}:${value}`),
    "",
    signedHeaders,
    payloadHash,
  ].join("\n");
  const scope = `${date}/${input.credentials.region}/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    hex(yield* sha256(encoder.encode(canonicalRequest))),
  ].join("\n");
  const dateKey = yield* hmac(encoder.encode(`AWS4${input.credentials.secretAccessKey}`), date);
  const regionKey = yield* hmac(dateKey, input.credentials.region);
  const serviceKey = yield* hmac(regionKey, "s3");
  const signingKey = yield* hmac(serviceKey, "aws4_request");
  const signature = hex(yield* hmac(signingKey, stringToSign));
  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
});
