import { describe, expect, it } from "vitest";

import { resolveStudioApiUrl } from "./api-url.ts";

describe("resolveStudioApiUrl", () => {
  it("rewrites the default studio.api_url to the API external URL", () => {
    expect(resolveStudioApiUrl("http://127.0.0.1", "127.0.0.1", "http://127.0.0.1:54321")).toBe(
      "http://127.0.0.1:54321",
    );
  });

  it("rewrites a schemeless/empty-host value to the API external URL", () => {
    expect(resolveStudioApiUrl("", "127.0.0.1", "http://127.0.0.1:54321")).toBe(
      "http://127.0.0.1:54321",
    );
  });

  it("leaves an explicit external host untouched", () => {
    expect(
      resolveStudioApiUrl("https://api.example.com", "127.0.0.1", "http://127.0.0.1:54321"),
    ).toBe("https://api.example.com");
  });

  it("leaves a value with the matching host but an explicit port untouched", () => {
    expect(
      resolveStudioApiUrl("http://127.0.0.1:3000", "127.0.0.1", "http://127.0.0.1:54321"),
    ).toBe("http://127.0.0.1:3000");
  });

  it("rewrites when the host matches a non-default configured hostname", () => {
    expect(resolveStudioApiUrl("http://my-host", "my-host", "http://my-host:54321")).toBe(
      "http://my-host:54321",
    );
  });
});
