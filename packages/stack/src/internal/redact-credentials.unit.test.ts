import { describe, expect, it } from "@effect/vitest";
import { redactCredentials } from "./redact-credentials.ts";

describe("redactCredentials", () => {
  it.each([
    {
      case: "redacts credential query values, any case",
      url: "/api/ok?select=*&apikey=sb_secret_x&Access_Token=jwt",
      redacted: "/api/ok?select=*&apikey=redacted&Access_Token=redacted",
    },
    {
      case: "redacts a nested credential next to a malformed escape",
      url: "/cb?redirect_to=https%3A%2F%2Fclient%2Fcb%3Faccess_token%3DJWT%ZZ&next=%E0%A4",
      redacted: "/cb?redirect_to=redacted&next=%E0%A4",
    },
    {
      case: "redacts an encoded credential name with a malformed value",
      url: "/x?access%5Ftoken=abc%ZZ",
      redacted: "/x?access%5Ftoken=redacted",
    },
    {
      case: "redacts an Edge Function websocket JWT",
      url: "/functions/v1/realtime-chat?jwt=eyJ.p.s",
      redacted: "/functions/v1/realtime-chat?jwt=redacted",
    },
    {
      case: "redacts Auth codes and OTP token hashes",
      url: "/auth/v1/verify?code=pkce&token_hash=h&type=signup",
      redacted: "/auth/v1/verify?code=redacted&token_hash=redacted&type=signup",
    },
    {
      case: "redacts S3 presigned URL signatures and session tokens",
      url: "/storage/v1/s3/b/o.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AK%2F20261001%2Flocal%2Fs3%2Faws4_request&X-Amz-Expires=60&X-Amz-Security-Token=st&X-Amz-Signature=abc",
      redacted:
        "/storage/v1/s3/b/o.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=redacted&X-Amz-Expires=60&X-Amz-Security-Token=redacted&X-Amz-Signature=redacted",
    },
    {
      case: "redacts fragment credentials of an absolute URL",
      url: "http://127.0.0.1:54321/x?token=t1&select=*#access_token=frag&type=bearer",
      redacted:
        "http://127.0.0.1:54321/x?token=redacted&select=*#access_token=redacted&type=bearer",
    },
    {
      case: "redacts refresh and provider tokens in a fragment",
      url: "http://127.0.0.1:54321/y?apikey=k#refresh_token=r&provider_token=p&provider_refresh_token=q",
      redacted:
        "http://127.0.0.1:54321/y?apikey=redacted#refresh_token=redacted&provider_token=redacted&provider_refresh_token=redacted",
    },
    {
      case: "redacts an encoded nested URL carrying a token",
      url: "/elsewhere?redirect_to=https%3A%2F%2Fclient%2Fcb%3Faccess_token%3DJWT",
      redacted: "/elsewhere?redirect_to=redacted",
    },
    {
      case: "redacts a raw nested URL carrying a token",
      url: "/down?redirect_to=https://client/cb?access_token=JWT",
      redacted: "/down?redirect_to=redacted",
    },
    {
      case: "redacts a doubly encoded nested URL carrying a token",
      url: "/down?back=https%253A%252F%252Fclient%252Fcb%253Faccess_token%253DJWT",
      redacted: "/down?back=redacted",
    },
    {
      case: "redacts a nested URL with userinfo",
      url: "/elsewhere?return_to=https%3A%2F%2Fuser%3Asecret%40client%2Fcb",
      redacted: "/elsewhere?return_to=redacted",
    },
    {
      case: "redacts userinfo of an absolute URL",
      url: "https://user:password@studio.test/relative?Access_Token=jwt",
      redacted: "https://redacted@studio.test/relative?Access_Token=redacted",
    },
    {
      case: "redacts a value that embeds a credential pair",
      url: "/api?data=a=token=b",
      redacted: "/api?data=redacted",
    },
    {
      case: "keeps a nested URL without credentials, with its encoding",
      url: "/elsewhere?next=http%3A%2F%2Flocalhost%3A3000%2F&country_code=FR",
      redacted: "/elsewhere?next=http%3A%2F%2Flocalhost%3A3000%2F&country_code=FR",
    },
    {
      case: "keeps a path without a query",
      url: "/rest/v1/todos",
      redacted: "/rest/v1/todos",
    },
  ])("$case", ({ url, redacted }) => {
    expect(redactCredentials(url)).toBe(redacted);
  });
});
