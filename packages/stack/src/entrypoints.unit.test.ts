import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, expectTypeOf, it } from "vitest";
import * as bunRoot from "./bun.ts";
import * as bunEffect from "./effect-bun.ts";
import * as nodeEffect from "./effect-node.ts";
import * as nodeRoot from "./node.ts";
import * as managed from "./managed-bun.ts";
import * as testing from "./testing.ts";
import type { StackHandle } from "./createStack.ts";
import type { Stack } from "./Stack.ts";
import type { Layer } from "effect";

describe("@supabase/stack entrypoints", () => {
  it("declares only intentional package entrypoints", () => {
    const srcDir = dirname(fileURLToPath(import.meta.url));
    const packageJson = JSON.parse(readFileSync(join(srcDir, "../package.json"), "utf8")) as {
      readonly exports: Record<string, string | Record<string, string>>;
      readonly knip: { readonly entry: ReadonlyArray<string> };
    };

    expect(packageJson.exports["."]).toEqual({ bun: "./src/bun.ts", default: "./src/node.ts" });
    expect(packageJson.exports["./effect"]).toEqual({
      bun: "./src/effect-bun.ts",
      default: "./src/effect-node.ts",
    });
    expect(packageJson.exports["./managed"]).toEqual({
      bun: "./src/managed-bun.ts",
      default: "./src/managed-node.ts",
    });
    expect(packageJson.exports["./managed-model"]).toBe("./src/managed/model.ts");
    expect(packageJson.exports["./testing"]).toBe("./src/testing.ts");
    expect(packageJson.exports["./daemon-bun"]).toBe("./src/daemon-bun.ts");
    expect(packageJson.exports["./daemon-node"]).toBeUndefined();
    expect(packageJson.knip.entry).toContain("src/daemon-node.ts");
  });

  it("keeps the root runtime surface Promise-only", () => {
    expect(Object.keys(nodeRoot).sort()).toEqual(["createStack", "prefetch"]);
    expect(Object.keys(bunRoot).sort()).toEqual(["createStack", "prefetch"]);
    expectTypeOf(nodeRoot.createStack).returns.toEqualTypeOf<Promise<StackHandle>>();
    expectTypeOf(bunRoot.createStack).returns.toEqualTypeOf<Promise<StackHandle>>();
  });

  it("exposes only the managed manager and supervisor APIs", () => {
    expect(managed).toHaveProperty("createManagedStackManager");
    expect(managed).toHaveProperty("managedStackManagerLayer");
    expect(managed).toHaveProperty("ManagedStackManager");
    expect(managed).toHaveProperty("managedDaemonLayer");
    expect(managed).not.toHaveProperty("createManagedStackService");
    expect(managed).not.toHaveProperty("ManagedStackRepository");
    expect(managed).not.toHaveProperty("bunSqliteManagedStackRepositoryLayer");
  });

  it("binds consumer Effect layers without exposing implementation tags", () => {
    expectTypeOf(nodeEffect.foregroundLayer).returns.toEqualTypeOf<Layer.Layer<Stack>>();
    expectTypeOf(bunEffect.foregroundLayer).returns.toEqualTypeOf<Layer.Layer<Stack>>();
    for (const entrypoint of [nodeEffect, bunEffect]) {
      expect(entrypoint).toHaveProperty("connectLayer");
      expect(entrypoint).toHaveProperty("daemonLayer");
      expect(entrypoint).toHaveProperty("foregroundLayer");
      expect(entrypoint).toHaveProperty("unixHttpClientLayer");
      expect(entrypoint).not.toHaveProperty("DaemonServer");
    }
  });

  it("keeps only runtime test seams in the testing entry", () => {
    expect(testing).toHaveProperty("DaemonServer");
    expect(testing).toHaveProperty("UnixHttpClient");
    expect(testing).not.toHaveProperty("ManagedStackRepository");
    expect(testing).not.toHaveProperty("managedStackContractFixtures");
  });
});
