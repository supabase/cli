import { describe, expect, it } from "vitest";
import { bundleServeMainTemplate } from "./serve-main-bundler.ts";

describe("stack-owned functions bootstrap", () => {
  it("bundles an offline self-contained Edge Runtime service", async () => {
    const bundled = await bundleServeMainTemplate();
    expect(bundled).toContain("Deno.serve");
    expect(bundled).not.toContain("jsr:");
    expect(bundled).not.toContain("https://");
    expect(bundled).not.toMatch(/from\s*["']jose["']/u);
  });
});
