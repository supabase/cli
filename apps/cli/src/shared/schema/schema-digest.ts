import { createHash } from "node:crypto";
import type { SchemaSqlFile } from "./schema-types.ts";

export function digestUtf8(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function digestFileSet(files: ReadonlyArray<SchemaSqlFile>): string {
  const hash = createHash("sha256");
  const sorted = [...files].sort((left, right) => left.name.localeCompare(right.name));
  for (const file of sorted) {
    hash.update(file.name);
    hash.update("\0");
    hash.update(file.sql);
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function digestVersions(versions: ReadonlyArray<string>): string {
  return digestUtf8(versions.join("\n"));
}
