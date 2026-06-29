import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { bundleServeMainTemplate } from "./serve-main-bundler.ts";

/**
 * The Go CLI (`supabase start`, which proxies to the Go binary) embeds the
 * edge-runtime bootstrap template too. To avoid the two templates drifting apart —
 * the gap that left `supabase start` broken offline after the TS fix — the Go binary
 * embeds the *same* bundled output, generated from the canonical `serve.main.ts`.
 *
 * This guards that the committed artifact is up to date. Regenerate with
 * `bun scripts/generate-go-serve-template.ts` (or `pnpm generate:go-serve-template`).
 */
const goBundledTemplatePath = fileURLToPath(
  new URL("../../../../cli-go/internal/functions/serve/templates/main.bundled.js", import.meta.url),
);

describe("Go edge-runtime bootstrap template", () => {
  it("is the up-to-date bundle of serve.main.ts", async () => {
    const committed = readFileSync(goBundledTemplatePath, "utf8");
    const expected = await bundleServeMainTemplate();
    expect(committed).toBe(expected);
  });
});
