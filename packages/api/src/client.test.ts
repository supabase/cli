import { afterEach, describe, expect, mock, test } from "bun:test";
import { createApiClient } from "./client.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("createApiClient", () => {
  test("sends the renamed Supabase CLI user agent", async () => {
    let request: Request | undefined;
    const fetchMock = mock(async (input: RequestInfo | URL, _init?: RequestInit) => {
      request = input instanceof Request ? input : new Request(input, _init);
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const client = createApiClient({
      baseUrl: "https://api.supabase.com",
      accessToken: "test-token",
      version: "1.2.3",
    }) as any;

    await client.GET("/");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(request).toBeDefined();

    expect(request?.headers.get("authorization")).toBe("Bearer test-token");
    expect(request?.headers.get("user-agent")).toBe("supabase-cli/1.2.3");
  });
});
