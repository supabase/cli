// oxlint-disable effecttsgo/node-builtin-import, effecttsgo/prefer-schema-over-json -- Tests intentionally exercise native async, HTTP, timer, and subprocess boundaries.
import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Cause, Effect, Exit, FileSystem, Layer, PlatformError, Predicate } from "effect";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect } from "vitest";
import { managedStackDocumentPathEffect, managedStackPathsEffect } from "./managed/paths.ts";
import { makeStackStore } from "./managed/store.ts";
import type { ManagedStackDocument } from "./managed/document.ts";

const STACK_ID = "11111111-1111-4111-8111-111111111111";
const HEALTHY_ID = "33333333-3333-4333-8333-333333333333";
const CORRUPT_ID = "22222222-2222-4222-8222-222222222222";

const filesystemLayer = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer);
const temporaryRoots: Array<string> = [];
let resetDisappearance: (() => void) | undefined;

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

const disappearingDocumentFileSystemLayer = Layer.effect(
  FileSystem.FileSystem,
  Effect.gen(function* () {
    const base = yield* FileSystem.FileSystem;
    let disappearNext = true;
    resetDisappearance = () => {
      disappearNext = true;
    };
    return {
      ...base,
      readFileString: (path: string, options?: Parameters<typeof base.readFileString>[1]) => {
        if (path.endsWith("stack.json") && disappearNext) {
          disappearNext = false;
          return Effect.fail(
            PlatformError.systemError({
              _tag: "NotFound",
              module: "test",
              method: "readFileString",
              description: "injected disappearance",
            }),
          );
        }
        return base.readFileString(path, options);
      },
      exists: (path: string) =>
        path.endsWith("stack.json") && disappearNext ? Effect.succeed(true) : base.exists(path),
    } satisfies FileSystem.FileSystem;
  }),
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
  launch: { mode: "native", versions: {} },
  createdAt: "2026-08-16T00:00:00.000Z",
  updatedAt: "2026-08-16T00:00:00.000Z",
  ...overrides,
});

const makeTempStackStore = (stateRoot = makeRoot()) => makeStackStore(stateRoot);

const writeRawStackDocument = (stateRoot: string, stackId: string, content: string): void => {
  const stackRoot = Effect.runSync(managedStackPathsEffect(stateRoot, stackId)).root;
  mkdirSync(stackRoot, { recursive: true });
  writeFileSync(Effect.runSync(managedStackDocumentPathEffect(stateRoot, stackId)), content);
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
            containerRuntime: "docker",
            versions: { postgres: "17.6.1" },
            excludedServices: ["studio", "analytics"],
            lastNotifiedUpdateFingerprint: "fingerprint",
          },
        }),
      );
      expect((yield* store.read(STACK_ID))?.launch).toEqual({
        mode: "docker",
        containerRuntime: "docker",
        versions: { postgres: "17.6.1" },
        excludedServices: ["studio", "analytics"],
        lastNotifiedUpdateFingerprint: "fingerprint",
      });
    }).pipe(Effect.provide(filesystemLayer)),
  );

  it.live("rejects unknown launch modes as invalid managed documents", () =>
    Effect.gen(function* () {
      const store = yield* makeTempStackStore();
      writeRawStackDocument(
        store.stateRoot,
        STACK_ID,
        JSON.stringify({ ...document(), launch: { mode: "auto", versions: {} } }),
      );

      const exit = yield* store.read(STACK_ID).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(
          Predicate.isTagged(Cause.squash(exit.cause), "InvalidManagedStackDocumentError"),
        ).toBe(true);
      }
    }).pipe(Effect.provide(filesystemLayer)),
  );

  it.live("rejects managed documents without a concrete launch selection", () =>
    Effect.gen(function* () {
      const store = yield* makeTempStackStore();
      const { launch: _launch, ...withoutLaunch } = document();
      writeRawStackDocument(store.stateRoot, STACK_ID, JSON.stringify(withoutLaunch));

      const exit = yield* store.read(STACK_ID).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(
          Predicate.isTagged(Cause.squash(exit.cause), "InvalidManagedStackDocumentError"),
        ).toBe(true);
      }
    }).pipe(Effect.provide(filesystemLayer)),
  );

  it.live("rejects an incomplete Docker launch as an invalid managed document", () =>
    Effect.gen(function* () {
      const store = yield* makeTempStackStore();
      writeRawStackDocument(
        store.stateRoot,
        STACK_ID,
        JSON.stringify({ ...document(), launch: { mode: "docker", versions: {} } }),
      );

      const exit = yield* store.read(STACK_ID).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(
          Predicate.isTagged(Cause.squash(exit.cause), "InvalidManagedStackDocumentError"),
        ).toBe(true);
      }
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

  it.live("lists an unreadable stack as corrupt without hiding healthy stacks", () =>
    Effect.gen(function* () {
      const store = yield* makeTempStackStore();
      yield* store.write(document({ id: HEALTHY_ID }));
      const corruptPath = yield* managedStackDocumentPathEffect(store.stateRoot, CORRUPT_ID);
      yield* Effect.sync(() => mkdirSync(corruptPath, { recursive: true }));

      const listings = yield* store.list();
      expect(listings).toEqual([
        expect.objectContaining({
          id: CORRUPT_ID,
          status: "corrupt",
          cause: expect.any(PlatformError.PlatformError),
        }),
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

  it.live(
    "treats a document that disappears after exists as absent and skips it from listings",
    () =>
      Effect.gen(function* () {
        const store = yield* makeTempStackStore();
        yield* store.write(document());
        expect(yield* store.read(STACK_ID)).toBeUndefined();
        if (resetDisappearance === undefined) throw new Error("expected injected filesystem");
        resetDisappearance();
        expect(yield* store.list()).toEqual([]);
      }).pipe(Effect.provide(Layer.mergeAll(disappearingDocumentFileSystemLayer, NodePath.layer))),
  );
});
