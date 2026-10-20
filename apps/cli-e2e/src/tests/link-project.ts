import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Writes `project-ref` and a stub `pooler-url` so `--remote` commands reach their handler without a live Postgres probe. */
export function linkProject(dir: string, ref: string): void {
  const tempDir = join(dir, "supabase", ".temp");
  mkdirSync(tempDir, { recursive: true });
  writeFileSync(join(tempDir, "project-ref"), ref);
  writeFileSync(
    join(tempDir, "pooler-url"),
    `postgresql://postgres.${ref}:[YOUR-PASSWORD]@aws-0-eu-central-1.pooler.supabase.com:6543/postgres`,
  );
}
