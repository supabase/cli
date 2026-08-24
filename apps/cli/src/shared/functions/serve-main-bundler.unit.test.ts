import { describe, expect, it } from "vitest";
import { Effect } from "effect";

import { bundleServeMainTemplate } from "./serve-main-bundler.ts";

describe("bundleServeMainTemplate", () => {
  it("produces a self-contained runtime template with no remote import specifiers", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const bundled = yield* bundleServeMainTemplate();

        // The offline failure (#45570) was caused by these being resolved over the
        // network on every container start. They must be inlined into the bundle.
        // Effect's bundled diagnostics include documentation URLs as plain
        // strings; only import specifiers must stay network-independent.
        expect(bundled).not.toMatch(/(?:from|import\s*\()\s*["']https?:\/\//);
        expect(bundled).not.toContain("jsr:");
        expect(bundled).not.toMatch(/from\s*["']jose["']/);
      }),
    ));

  it("preserves the template's Deno.serve entrypoint and inlines jose", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const bundled = yield* bundleServeMainTemplate();

        // Template body survives bundling (Deno global left as a free reference).
        expect(bundled).toContain("Deno.serve");
        // jose is inlined, so the bundle is materially larger than the ~12KB template.
        expect(bundled.length).toBeGreaterThan(20_000);
      }),
    ));
});
