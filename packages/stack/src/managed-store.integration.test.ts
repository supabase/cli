import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Cause, Effect, Exit, FileSystem, Layer, PlatformError } from "effect";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect } from "vitest";
import { managedStackDocumentPath, managedStackPaths } from "./managed/paths.ts";
import { makeStackStore } from "./managed/store.ts";
import type { ManagedStackDocument } from "./managed/document.ts";

const STACK_ID = "11111111-1111-4111-8111-111111111111";
const HEALTHY_ID = "33333333-3333-4333-8333-333333333333";
const CORRUPT_ID = "22222222-2222-4222-8222-222222222222";

const filesystemLayer = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer);
const temporaryRoots: Array<string> = [];

const failingWriteFileSystemLayer = Layer.effect(
  FileSystem.FileSystem,
  Effect.map(FileSystem.FileSystem, (fs) => ({
    ...fs,
    writeFileString: (
      _path: string,
      _data: string,
      _options?: Parameters<FileSystem.FileSystem["writeFileString"]>[2],
    ) =>
      Effect.fail(
        PlatformError.systemError({
          _tag: "PermissionDenied",
          module: "test",
          method: "writeFileString",
          description: "injected write failure",
        }),
      ),
  })),
).pipe(Layer.provide(NodeFileSystem.layer));

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

const makeRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "managed-store-test-"));
  temporaryRoots.push(root);
  return root;
};

const document = (overrides: Partial<ManagedStackDocument> = {}): ManagedStackDocument => ({
  format: "supabase-stack",
  formatVersion: 1,
  id: STACK_ID,
  identity: {
    workspaceId: "workspace-id",
    checkoutId: "checkout-id",
    contextId: "context-id",
    localProjectKey: ".",
    name: "default",
  },
  workspace: {
    kind: "folder",
    checkoutKind: "folder",
    path: "/tmp/project",
  },
  ports: [
    { key: "api.port", port: 54321, intent: "automatic" },
    { key: "db.port", port: 54322, intent: "automatic" },
  ],
  lifecycle: "stopped",
  createdAt: "2026-08-16T00:00:00.000Z",
  updatedAt: "2026-08-16T00:00:00.000Z",
  ...overrides,
});

const makeTempStackStore = (stateRoot = makeRoot()) => makeStackStore(stateRoot);

const writeRawStackDocument = (stateRoot: string, stackId: string, content: string): void => {
  const stackRoot = managedStackPaths(stateRoot, stackId).root;
  mkdirSync(stackRoot, { recursive: true });
  writeFileSync(managedStackDocumentPath(stateRoot, stackId), content);
};

describe("managed stack document store", () => {
  it.live("persists and replaces one complete stack document atomically", () =>
    Effect.gen(function* () {
      const store = yield* makeTempStackStore();
      yield* store.write(document({ lifecycle: "starting" }));
      yield* store.write(document({ lifecycle: "running" }));
      const invalid = yield* store
        .write(document({ ports: [{ key: "api.port", port: 54321, intent: "automatic" }] }))
        .pipe(Effect.exit);
      expect(Exit.isFailure(invalid)).toBe(true);
      if (Exit.isFailure(invalid)) {
        expect(Cause.squash(invalid.cause)).toMatchObject({
          _tag: "InvalidManagedStackDocumentError",
        });
      }
      expect(yield* store.read(STACK_ID)).toMatchObject({ lifecycle: "running" });
    }).pipe(Effect.provide(filesystemLayer)),
  );

  it.live("persists launch selections needed for detached CLI reattachment", () =>
    Effect.gen(function* () {
      const store = yield* makeTempStackStore();
      yield* store.write(
        document({
          launch: {
            mode: "docker",
            versions: { postgres: "17.6.1" },
            excludedServices: ["studio", "analytics"],
            lastNotifiedUpdateFingerprint: "fingerprint",
          },
        }),
      );
      expect((yield* store.read(STACK_ID))?.launch).toEqual({
        mode: "docker",
        versions: { postgres: "17.6.1" },
        excludedServices: ["studio", "analytics"],
        lastNotifiedUpdateFingerprint: "fingerprint",
      });
    }).pipe(Effect.provide(filesystemLayer)),
  );

  it.live("lists a corrupt stack beside healthy stacks", () =>
    Effect.gen(function* () {
      const store = yield* makeTempStackStore();
      yield* store.write(document({ id: HEALTHY_ID }));
      writeRawStackDocument(store.stateRoot, CORRUPT_ID, "not-json");
      expect(yield* store.list()).toEqual([
        expect.objectContaining({ id: CORRUPT_ID, status: "corrupt" }),
        expect.objectContaining({ id: HEALTHY_ID, status: "healthy" }),
      ]);
    }).pipe(Effect.provide(filesystemLayer)),
  );

  it.live("keeps a store filesystem failure in the typed error channel", () =>
    Effect.gen(function* () {
      const store = yield* makeTempStackStore();
      const exit = yield* store.write(document()).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.hasDies(exit.cause)).toBe(false);
        expect(Cause.squash(exit.cause)).toBeInstanceOf(PlatformError.PlatformError);
      }
    }).pipe(Effect.provide(Layer.mergeAll(failingWriteFileSystemLayer, NodePath.layer))),
  );
});
