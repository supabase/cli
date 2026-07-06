import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

describe("@supabase/stack entrypoints", () => {
  it("ships conditional root exports and keeps only the effect subpath", () => {
    const srcDir = dirname(fileURLToPath(import.meta.url));
    const packageJson = JSON.parse(readFileSync(join(srcDir, "../package.json"), "utf8")) as {
      readonly exports: Record<string, string | Record<string, string>>;
    };

    expect(packageJson.exports["."]).toEqual({
      bun: "./src/bun.ts",
      default: "./src/node.ts",
    });
    expect(packageJson.exports["./effect"]).toBe("./src/effect.ts");
    expect(packageJson.exports["./bun"]).toBeUndefined();
    expect(packageJson.exports["./node"]).toBeUndefined();
    expect(packageJson.exports["./internals"]).toBeUndefined();
  });
});
