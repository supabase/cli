import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Effect, FileSystem, Layer, PlatformError } from "effect";
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

  it.live("reports unsupported hard-link publication as a typed failure", () => {
    const root = makeRoot();
    const unsupportedLayer = Layer.effect(
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
              cause: { code: "ENOTSUP" },
            }),
          ),
      })),
    ).pipe(Layer.provide(NodeFileSystem.layer));

    return Effect.gen(function* () {
      const failure = yield* Effect.flip(
        claimFileAtomically(join(root, "identity.json"), "content\n"),
      );
      expect(failure).toBeInstanceOf(AtomicClaimUnsupportedError);
      const fs = yield* FileSystem.FileSystem;
      expect(yield* fs.readDirectory(root)).toEqual([]);
    }).pipe(Effect.provide(unsupportedLayer));
  });
});
