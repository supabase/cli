/* oxlint-disable effecttsgo/global-console, effecttsgo/async-function, effecttsgo/node-builtin-import, effecttsgo/process-env, effecttsgo/new-promise -- standalone Bun dev script for the output gallery, not CLI runtime code */
/* Captures `--help` for every command into gallery records, walking the SUBCOMMANDS sections.
   Usage: bun scripts/gallery-help.ts <records-dir> [command words...]; words limit it to that command
   and its subcommands. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cpus, tmpdir } from "node:os";
import { createHarness, exec } from "@supabase/cli-test-helpers";

/** Width of the pseudo-terminal the gallery captures in; override with GALLERY_COLUMNS. */
const GALLERY_COLUMNS = Number(process.env["GALLERY_COLUMNS"]) || 160;

const [recordsDir, ...prefix] = process.argv.slice(2);
if (!recordsDir) {
  console.error("usage: bun scripts/gallery-help.ts <records-dir>");
  process.exit(1);
}
mkdirSync(recordsDir, { recursive: true });

const harness = createHarness({
  apiUrl: "http://127.0.0.1:9",
  accessToken: "sbp_" + "0".repeat(40),
  cwd: tmpdir(),
});

const subcommands = (help: string): string[] => {
  const section = help.split(/\n(?=[A-Z][A-Z ]+\n)/).find((part) => part.startsWith("SUBCOMMANDS"));
  if (!section) return [];
  return section
    .split("\n")
    .slice(1)
    .map((line) => /^ {2}([a-z][\w-]*)\s{2,}/.exec(line)?.[1])
    .filter((name): name is string => name !== undefined);
};

const concurrency = Number(process.env["GALLERY_CONCURRENCY"]) || cpus().length;

const capture = async (path: string[]): Promise<ReadonlyArray<ReadonlyArray<string>>> => {
  const args = [...path, "--help"];
  const [piped, tty] = await Promise.all([
    exec(harness, args),
    exec(harness, args, { tty: { columns: GALLERY_COLUMNS, rows: 50 } }),
  ]);
  const slug = ["help", ...path].join("-") || "help-root";
  writeFileSync(
    join(recordsDir, `${slug}.json`),
    JSON.stringify({
      suite: `--help ${path[0] ?? "supabase"}`,
      test: ["supabase", ...path].join(" "),
      slug,
      file: "--help",
      args,
      piped,
      tty,
    }),
  );
  return subcommands(piped.stdout).map((name) => [...path, name]);
};

const started = performance.now();
const queue: Array<ReadonlyArray<string>> = [prefix];
let captured = 0;
let active = 0;
await new Promise<void>((done) => {
  const pump = () => {
    if (queue.length === 0 && active === 0) return done();
    while (active < concurrency && queue.length > 0) {
      const path = queue.shift()!;
      active += 1;
      void capture([...path])
        .catch((cause: unknown) => {
          console.error(`help capture failed for "${path.join(" ")}": ${String(cause)}`);
          return [];
        })
        .then((children) => {
          captured += 1;
          active -= 1;
          queue.push(...children);
          pump();
        });
    }
  };
  pump();
});
console.log(
  `captured ${captured} help pages in ${((performance.now() - started) / 1000).toFixed(1)}s at concurrency ${concurrency}`,
);
