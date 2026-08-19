import { createHash } from "node:crypto";
import { readdirSync, readFileSync, type Dirent } from "node:fs";
import { join } from "node:path";

const NATIVE_SHADOW_CACHE_FORMAT = "native-isolated-shadow-v2";

export const computeBaselineCacheKey = (input: {
  readonly postgresVersion: string;
  readonly autoExposeNewTables: boolean;
  readonly artifactDigest: string;
  readonly initScriptDigest: string;
}): string =>
  createHash("sha256")
    .update(NATIVE_SHADOW_CACHE_FORMAT)
    .update("\0")
    .update(input.postgresVersion)
    .update("\0")
    .update(input.autoExposeNewTables ? "1" : "0")
    .update("\0")
    .update(input.artifactDigest)
    .update("\0")
    .update(input.initScriptDigest)
    .digest("hex")
    .slice(0, 16);

export const digestArtifactTree = (root: string): string => {
  const hash = createHash("sha256");
  const walk = (dir: string, prefix: string) => {
    let entries: ReadonlyArray<Dirent>;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const sorted = [...entries].sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of sorted) {
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs, rel);
        continue;
      }
      if (!entry.isFile()) continue;
      hash.update(rel);
      hash.update("\0");
      hash.update(readFileSync(abs));
      hash.update("\0");
    }
  };
  walk(root, "");
  return hash.digest("hex");
};
