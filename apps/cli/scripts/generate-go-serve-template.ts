import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { bundleServeMainTemplate } from "../src/shared/functions/serve-main-bundler.ts";

/**
 * Generate the edge-runtime bootstrap template the Go CLI embeds (`go:embed`).
 *
 * The Go binary serves `supabase start`'s edge-runtime (the legacy shell proxies
 * `start` to it), so it needs the same offline-safe, self-contained template the TS
 * CLI ships (supabase/supabase#45570). Rather than maintain a second copy, both CLIs
 * embed the bundle of the single canonical source, `serve.main.ts`. A unit test
 * (`serve-main-go-template.unit.test.ts`) fails if this committed artifact drifts.
 */
const target = fileURLToPath(
  new URL("../../cli-go/internal/functions/serve/templates/main.bundled.js", import.meta.url),
);

await writeFile(target, await bundleServeMainTemplate());
console.log(`Wrote ${target}`);
