import { stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export async function findGitRootPath(startPath: string) {
  let current = resolve(startPath);

  for (;;) {
    try {
      await stat(resolve(current, ".git"));
      return current;
    } catch {
      // Keep walking until we hit the filesystem root.
    }

    const parent = dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}
