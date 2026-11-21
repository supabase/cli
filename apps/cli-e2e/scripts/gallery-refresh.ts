/* oxlint-disable effecttsgo/global-console, effecttsgo/async-function, effecttsgo/node-builtin-import, effecttsgo/process-env, effecttsgo/new-promise -- standalone Bun dev script for the output gallery, not CLI runtime code */
/* Re-captures one command (its --help pages and e2e tests) and rebuilds the gallery page.
   Usage: bun scripts/gallery-refresh.ts <gallery-dir> <command words...>
   e.g. bun scripts/gallery-refresh.ts $G projects list */
import { join } from "node:path";

const [galleryDir, ...words] = process.argv.slice(2);
if (!galleryDir || words.length === 0) {
  console.error("usage: bun scripts/gallery-refresh.ts <gallery-dir> <command words...>");
  process.exit(1);
}
const records = join(galleryDir, "records");
const started = performance.now();

const step = async (label: string, cmd: string[], env: Record<string, string> = {}) => {
  const t = performance.now();
  const proc = Bun.spawn(cmd, {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, ...env },
    stdout: "inherit",
    stderr: "inherit",
  });
  await proc.exited;
  console.log(`${label}: ${((performance.now() - t) / 1000).toFixed(1)}s`);
};

// Describe blocks name commands as "projects:list" or "db push"; accept either separator.
const testPattern = `(^|\\s)${words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[ :]")}\\b`;

await Promise.all([
  step("help", ["bun", "scripts/gallery-help.ts", records, ...words]),
  step("e2e", ["bun", "--bun", "vitest", "run", "--reporter=dot", "-t", testPattern], {
    CLI_GALLERY_DIR: records,
    CLI_E2E_FROM_SOURCE: "1",
  }),
]);
await step("page", ["bun", "scripts/gallery.ts", records, join(galleryDir, "index.html")]);
console.log(
  `refreshed "${words.join(" ")}" in ${((performance.now() - started) / 1000).toFixed(1)}s`,
);
