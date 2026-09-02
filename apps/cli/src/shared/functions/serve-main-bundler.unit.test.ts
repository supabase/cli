import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { bundleServeMainTemplate, serveMainEntrypoint } from "./serve-main-bundler.ts";
import {
  bundleServeMainTemplate as stackBundleServeMainTemplate,
  serveMainEntrypoint as stackServeMainEntrypoint,
} from "../../../../../packages/stack/src/functions/serve-main-bundler.ts";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "../../../../../packages/stack");

describe("bundleServeMainTemplate", () => {
  it("keeps the bootstrap private while bridging the stack-owned implementation", () => {
    const packageJson = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
      readonly exports: Record<string, string>;
    };

    expect(packageJson.exports).toEqual({
      ".": "./src/index.ts",
      "./effect": "./src/effect.ts",
      "./internal/supervisor": "./src/internal/supervisor-process.ts",
      "./testing": "./src/testing.ts",
    });
    expect(bundleServeMainTemplate).toBe(stackBundleServeMainTemplate);
    expect(serveMainEntrypoint).toBe(stackServeMainEntrypoint);
  });

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
