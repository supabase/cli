import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { daemonEntryPoint as bunDaemonEntryPoint, createStack as createBunStack } from "./bun.ts";
import {
  DEFAULT_VERSIONS,
  Stack,
  StackError,
  StackServiceState,
  connectLayer,
  projectDaemonLayer,
} from "./effect.ts";
import {
  daemonEntryPoint as nodeDaemonEntryPoint,
  createStack as createNodeStack,
} from "./node.ts";

describe("@supabase/stack entrypoints", () => {
  it("exports runtime-specific stack builders", () => {
    expect(typeof createBunStack).toBe("function");
    expect(typeof createNodeStack).toBe("function");
    expect(typeof bunDaemonEntryPoint).toBe("string");
    expect(typeof nodeDaemonEntryPoint).toBe("string");
  });

  it("consolidates advanced and internal APIs under effect", () => {
    expect(Stack).toBeDefined();
    expect(typeof connectLayer).toBe("function");
    expect(typeof projectDaemonLayer).toBe("function");
    expect(StackServiceState).toBeDefined();
    expect(StackError).toBeDefined();
    expect(DEFAULT_VERSIONS.postgres).toBeDefined();
  });

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
