import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, expectTypeOf, it } from "vitest";
import * as bunRoot from "./bun.ts";
import * as bunEffect from "./effect-bun.ts";
import * as nodeEffect from "./effect-node.ts";
import * as nodeRoot from "./node.ts";
import type { StackHandle } from "./createStack.ts";
import * as testing from "./testing.ts";

const INTERNAL_EFFECT_EXPORTS = [
  "ApiProxy",
  "BinaryResolver",
  "DaemonServer",
  "JwtGenerator",
  "RemoteStack",
  "StackBuilder",
  "UnixHttpClient",
  "createStack",
  "projectDaemonLayer",
] as const;

describe("@supabase/stack entrypoints", () => {
  it("declares only intentional package entrypoints", () => {
    const srcDir = dirname(fileURLToPath(import.meta.url));
    const packageJson = JSON.parse(readFileSync(join(srcDir, "../package.json"), "utf8")) as {
      readonly exports: Record<string, string | Record<string, string>>;
      readonly knip: { readonly entry: ReadonlyArray<string> };
    };

    expect(packageJson.exports).toEqual({
      ".": {
        bun: "./src/bun.ts",
        default: "./src/node.ts",
      },
      "./effect": {
        bun: "./src/effect-bun.ts",
        default: "./src/effect-node.ts",
      },
      "./testing": "./src/testing.ts",
      "./daemon-bun": "./src/daemon-bun.ts",
    });
    expect(packageJson.exports["./daemon-node"]).toBeUndefined();
    expect(packageJson.exports["./internals"]).toBeUndefined();
    expect(packageJson.knip.entry).toContain("src/daemon-node.ts");
  });

  it("keeps the root runtime surface Promise-only", () => {
    expect(Object.keys(nodeRoot).sort()).toEqual(["createStack", "prefetch"]);
    expect(Object.keys(bunRoot).sort()).toEqual(["createStack", "prefetch"]);
    expectTypeOf(nodeRoot.createStack).returns.toEqualTypeOf<Promise<StackHandle>>();
    expectTypeOf(bunRoot.createStack).returns.toEqualTypeOf<Promise<StackHandle>>();
  });

  it("binds consumer Effect layers without exposing implementation tags", () => {
    for (const entrypoint of [nodeEffect, bunEffect]) {
      expect(entrypoint).toHaveProperty("connectLayer");
      expect(entrypoint).toHaveProperty("daemonLayer");
      expect(entrypoint).toHaveProperty("foregroundLayer");
      expect(entrypoint).toHaveProperty("unixHttpClientLayer");
      for (const name of INTERNAL_EFFECT_EXPORTS) {
        expect(entrypoint).not.toHaveProperty(name);
      }
    }
  });

  it("isolates consumer test seams in the testing entry", () => {
    expect(Object.keys(testing).sort()).toEqual(["DaemonServer", "UnixHttpClient"]);
  });
});
