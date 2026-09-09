import { describe, expect, it } from "vitest";

import { resolveStudioApiUrl } from "./api-url.ts";

describe("resolveStudioApiUrl", () => {
  // Go's `Config.Validate` (`pkg/config/config.go:1074-1078`): a default
  // `studio.api_url` (`http://127.0.0.1`) has host `127.0.0.1`, matching the
  // default hostname, so it's rewritten to the resolved API external URL.
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
    // Go's `parsed.Host` includes the port when one is present, so `127.0.0.1:3000`
    // does not equal the bare `Hostname` `127.0.0.1` and is not rewritten.
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
