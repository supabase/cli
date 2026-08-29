import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, FileSystem, Path } from "effect";
import { StackIdSchema } from "../public/StackId.ts";
import { makeRuntimeEnvFileOwner } from "./RuntimeEnvFile.ts";

const stackId = StackIdSchema.make("e".repeat(64));

const withPlatform = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(effect).pipe(Effect.provide(NodeServices.layer));

describe("runtime environment file owner", () => {
  it.live("writes deterministic owner-only generation files atomically", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-env-" });
        const owner = yield* makeRuntimeEnvFileOwner({ stateRoot: root, stackId });
        const first = yield* owner.write({
          generation: 4,
          workloadId: "database:database",
          values: { Z_LAST: "two", A_FIRST: "one" },
        });
        const second = yield* owner.write({
          generation: 4,
          workloadId: "database:database",
          values: { A_FIRST: "updated" },
        });
        expect(second).toBe(first);
        expect(yield* fs.readFileString(first)).toBe("A_FIRST=updated\n");
        expect((yield* fs.stat(first)).mode & 0o777).toBe(0o600);
        expect((yield* fs.stat(path.dirname(first))).mode & 0o777).toBe(0o700);
      }),
    ),
  );

  it.live("rejects unsafe names and values without revealing the value", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-env-invalid-" });
        const owner = yield* makeRuntimeEnvFileOwner({ stateRoot: root, stackId });
        const secret = "very-secret-value";
        const invalid = yield* owner
          .write({
            generation: 1,
            workloadId: "database:database",
            values: { VALID: `${secret}\nINJECTED` },
          })
          .pipe(Effect.exit);
        expect(Exit.isFailure(invalid)).toBe(true);
        if (Exit.isFailure(invalid)) expect(String(invalid.cause)).not.toContain(secret);
        expect(yield* fs.exists(`${root}/${stackId}/runtime/env`)).toBe(false);
        const invalidWorkload = yield* owner
          .write({ generation: 1, workloadId: "../escape", values: { SAFE: "ok" } })
          .pipe(Effect.exit);
        expect(Exit.isFailure(invalidWorkload)).toBe(true);
      }),
    ),
  );

  it.live("cleans exact generations idempotently", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-env-cleanup-" });
        const owner = yield* makeRuntimeEnvFileOwner({ stateRoot: root, stackId });
        const file = yield* owner.write({
          generation: 2,
          workloadId: "rest:rest",
          values: { X: "y" },
        });
        yield* owner.cleanupGeneration(2);
        expect(yield* fs.exists(file)).toBe(false);
        yield* owner.cleanupGeneration(2);
        yield* owner.write({ generation: 3, workloadId: "rest:rest", values: { X: "z" } });
        yield* owner.cleanupAll;
        expect(yield* fs.exists(`${root}/${stackId}/runtime/env`)).toBe(false);
      }),
    ),
  );

  it.live("keeps concurrent workload files collision-free", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-env-concurrent-" });
        const owner = yield* makeRuntimeEnvFileOwner({ stateRoot: root, stackId });
        const files = yield* Effect.all(
          [
            owner.write({ generation: 7, workloadId: "rest:rest", values: { A: "one" } }),
            owner.write({ generation: 7, workloadId: "auth:auth", values: { B: "two" } }),
          ],
          { concurrency: "unbounded" },
        );
        expect(new Set(files).size).toBe(2);
        expect(yield* fs.readFileString(files[0])).toBe("A=one\n");
        expect(yield* fs.readFileString(files[1])).toBe("B=two\n");
      }),
    ),
  );
});
