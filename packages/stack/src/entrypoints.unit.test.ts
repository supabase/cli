import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, expectTypeOf, it } from "vitest";
import { Effect } from "effect";
import type { Layer } from "effect";
import * as bunRoot from "./bun.ts";
import * as bunEffect from "./effect-bun.ts";
import * as nodeEffect from "./effect-node.ts";
import * as nodeRoot from "./node.ts";
import * as managed from "./managed-bun.ts";
import type { StackHandle } from "./createStack.ts";
import type { Stack } from "./Stack.ts";
import * as testing from "./testing.ts";
import type {
  ManagedPruneRequest,
  ManagedPruneFailure,
  ManagedPruneResult,
  ManagedStackServiceHandle,
  ManagedStackServiceShape,
} from "./managed-bun.ts";

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
      "./managed": {
        bun: "./src/managed-bun.ts",
        default: "./src/managed-node.ts",
      },
      "./managed-model": "./src/managed/model.ts",
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

  it("exposes managed policy through its own entrypoint", () => {
    expect(managed).toHaveProperty("createManagedStackService");
    expect(managed).toHaveProperty("makeManagedStackService");
    expect(managed).toHaveProperty("ManagedStackService");
    expect(managed).toHaveProperty("managedStackLayer");
    expect(managed).toHaveProperty("bunSqliteManagedStackRepositoryLayer");
    expect(nodeRoot).not.toHaveProperty("createManagedStackService");
    expectTypeOf<ManagedStackServiceHandle["prune"]>().toEqualTypeOf<
      (request: ManagedPruneRequest) => Promise<ManagedPruneResult>
    >();
    expectTypeOf<ManagedStackServiceShape>().toHaveProperty("prune");
    expectTypeOf<ManagedStackServiceShape["prune"]>().toMatchTypeOf<
      (request: ManagedPruneRequest) => Effect.Effect<ManagedPruneResult, ManagedPruneFailure>
    >();
  });

  it("pins the managed runtime surface so internals cannot leak into it", () => {
    // The in-memory repository is a test seam and belongs to `./testing` only;
    // the adapters' shared port and update guards stay module-internal.
    expect(Object.keys(managed).sort()).toEqual([
      "DEFAULT_MANAGED_STACK_NAME",
      "DuplicateManagedIdentityError",
      "DuplicateManagedPortKeyError",
      "GIT_CHECKOUT_IDENTITY_VERSION",
      "GIT_PROJECT_ID_KEY",
      "GitConfigStore",
      "IncompatibleManagedRegistryError",
      "InvalidManagedIdentityError",
      "InvalidManagedOwnerPidError",
      "InvalidManagedPortError",
      "InvalidManagedStackNameError",
      "MANAGED_ERROR_CODES",
      "MANAGED_ERROR_TAG_BY_CODE",
      "ManagedAbandonedOperationError",
      "ManagedCheckoutConflictError",
      "ManagedCopiedBranchConflictError",
      "ManagedIdentityTransitionOwnershipError",
      "ManagedInaccessiblePathError",
      "ManagedOperationInProgressError",
      "ManagedOperationOwnershipError",
      "ManagedPendingStackUpdateError",
      "ManagedPortReservationError",
      "ManagedRunningStackPortChangeError",
      "ManagedStackInitializationError",
      "ManagedStackNotFoundError",
      "ManagedStackNotStoppedError",
      "ManagedStackPublicationTimeoutError",
      "ManagedStackRepository",
      "ManagedStackService",
      "ORDINARY_WORKSPACE_IDENTITY_VERSION",
      "UnsafeManagedStackPathError",
      "UnsupportedGitWorkspaceError",
      "assertManagedStackRoot",
      "assertManagedUuid",
      "bunSqliteManagedStackRepositoryLayer",
      "createManagedStackService",
      "createManagedUuid",
      "ensureBranchContextId",
      "ensureGitCheckoutIdentity",
      "ensureOrdinaryWorkspaceIdentity",
      "gitBranchContextIdKey",
      "gitCheckoutIdentityPath",
      "gitConfigPath",
      "gitConfigStoreLayer",
      "gitWorktreeConfigPath",
      "inspectWorkspace",
      "isManagedStackError",
      "makeManagedStackService",
      "managedRegistryPath",
      "managedStackLayer",
      "managedStackPaths",
      "ordinaryWorkspaceIdentityPath",
      "readBranchContextId",
      "readGitCheckoutIdentity",
      "readOrdinaryWorkspaceIdentity",
      "requireExplicitManagedStateRoot",
      "resolveManagedStateRoot",
    ]);
  });

  it("binds consumer Effect layers without exposing implementation tags", () => {
    expectTypeOf(nodeEffect.foregroundLayer).returns.toEqualTypeOf<Layer.Layer<Stack>>();
    expectTypeOf(bunEffect.foregroundLayer).returns.toEqualTypeOf<Layer.Layer<Stack>>();

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
    expect(Object.keys(testing).sort()).toEqual([
      "DaemonServer",
      "UnixHttpClient",
      "createInMemoryManagedStackRepository",
      "managedNativePlatformByNodeTarget",
      "managedNativePlatformFromNode",
      "managedNativeServiceMatrix",
      "managedStackContractFixtures",
      "validateManagedStackContractFixtures",
    ]);
  });
});
