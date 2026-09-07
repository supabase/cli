import { describe, expect, it } from "vitest";

import { bundleServeMainTemplate } from "./serve-main-bundler.ts";

describe("bundleServeMainTemplate", () => {
  it("produces a self-contained runtime template with no remote import specifiers", async () => {
    const bundled = await bundleServeMainTemplate();

    // The offline failure (#45570) was caused by these being resolved over the
    // network on every container start. They must be inlined into the bundle.
    expect(bundled).not.toContain("https://");
    expect(bundled).not.toContain("jsr:");
    expect(bundled).not.toMatch(/from\s*["']jose["']/);
  });

  it("preserves the template's Deno.serve entrypoint and inlines jose", async () => {
    const bundled = await bundleServeMainTemplate();

    // Template body survives bundling (Deno global left as a free reference).
    expect(bundled).toContain("Deno.serve");
    // jose is inlined, so the bundle is materially larger than the ~12KB template.
    expect(bundled.length).toBeGreaterThan(20_000);
  });
});
