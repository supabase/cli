import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Writes .supabase/.temp/project-ref and a stub pooler-url so --remote
 *  commands resolve a connection without a live postgres TCP probe (nothing
 *  listens on db.{ref}.localhost:5432 in the test harness); combined with
 *  SUPABASE_DB_PASSWORD (set in harness.ts), the command reaches its handler
 *  and makes the Management API call under test. */
export function linkProject(dir: string, ref: string): void {
  const tempDir = join(dir, "supabase", ".temp");
  mkdirSync(tempDir, { recursive: true });
  writeFileSync(join(tempDir, "project-ref"), ref);
  writeFileSync(
    join(tempDir, "pooler-url"),
    `postgresql://postgres.${ref}:[YOUR-PASSWORD]@aws-0-eu-central-1.pooler.supabase.com:6543/postgres`,
  );
}
