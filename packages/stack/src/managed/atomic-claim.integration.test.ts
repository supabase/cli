// oxlint-disable effecttsgo/node-builtin-import -- Atomic claim integration tests use native filesystem fixtures to verify cross-process claims.

import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Deferred, Effect, Fiber, FileSystem, Layer, PlatformError } from "effect";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect } from "vitest";
import { AtomicClaimUnsupportedError, claimFileAtomically } from "./atomic-claim.ts";

const roots: Array<string> = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const makeRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "managed-claim-test-"));
  roots.push(root);
  return root;
};

const interruptibleLinkLayer = (
  started: Deferred.Deferred<void>,
  release: Deferred.Deferred<void>,
) =>
  Layer.effect(
    FileSystem.FileSystem,
    Effect.map(FileSystem.FileSystem, (fs) => {
      let blockNextLink = true;
      return {
        ...fs,
        link: (fromPath: string, toPath: string) => {
          if (!blockNextLink) return fs.link(fromPath, toPath);
          blockNextLink = false;
          return Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.andThen(fs.link(fromPath, toPath)),
          );
        },
      };
    }),
  ).pipe(Layer.provide(NodeFileSystem.layer));

const unsupportedLinkLayer = (code: string) =>
  Layer.effect(
    FileSystem.FileSystem,
    Effect.map(FileSystem.FileSystem, (fs) => ({
      ...fs,
      link: (_fromPath: string, _toPath: string) =>
        Effect.fail(
          PlatformError.systemError({
            _tag: "Unknown",
            module: "test",
            method: "link",
            description: "hard links are unavailable",
            cause: { code },
          }),
        ),
    })),
  ).pipe(Layer.provide(NodeFileSystem.layer));

describe("managed atomic claims", () => {
  it.live("concurrent claimants publish exactly one complete marker", () => {
    const target = join(makeRoot(), "identity.json");
    return Effect.gen(function* () {
      const outcomes = yield* Effect.all(
        Array.from({ length: 8 }, (_, index) =>
          claimFileAtomically(target, `winner-${index}\n`, { mode: 0o600 }),
        ),
        { concurrency: "unbounded" },
      );
      const fs = yield* FileSystem.FileSystem;
      const content = yield* fs.readFileString(target);
      expect(outcomes.filter((outcome) => outcome === "claimed")).toHaveLength(1);
      expect(content).toMatch(/^winner-[0-7]\n$/);
    }).pipe(Effect.provide(NodeFileSystem.layer));
  });

  it.live("reports unsupported hard-link publication errors as typed failures", () => {
    return Effect.gen(function* () {
      for (const code of ["ENOTSUP", "ENOSYS", "EXDEV"] as const) {
        const root = makeRoot();
        const unsupportedLayer = unsupportedLinkLayer(code);

        const failure = yield* Effect.flip(
          claimFileAtomically(join(root, "identity.json"), "content\n").pipe(
            Effect.provide(unsupportedLayer),
          ),
        );
        expect(failure).toBeInstanceOf(AtomicClaimUnsupportedError);
        const entries = yield* Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          return yield* fs.readDirectory(root);
        }).pipe(Effect.provide(unsupportedLayer));
        expect(entries).toEqual([]);
      }
    });
  });

  it.live("cleans interrupted publication state so a later claim can retry", () => {
    const root = makeRoot();
    const target = join(root, "identity.json");
    return Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const layer = interruptibleLinkLayer(started, release);
      const first = yield* claimFileAtomically(target, "first\n").pipe(
        Effect.provide(layer),
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Deferred.await(started);
      yield* Fiber.interrupt(first);
      yield* Deferred.succeed(release, undefined);

      const fs = yield* FileSystem.FileSystem;
      expect(yield* fs.exists(target)).toBe(false);
      expect(yield* fs.readDirectory(root)).toEqual([]);

      const retried = yield* claimFileAtomically(target, "second\n").pipe(Effect.provide(layer));
      expect(retried).toBe("claimed");
      expect(yield* fs.readFileString(target)).toBe("second\n");
    }).pipe(Effect.provide(NodeFileSystem.layer));
  });
});
