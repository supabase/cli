import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, FileSystem, Path } from "effect";
import { StackIdSchema } from "../public/StackId.ts";
import { makeRuntimeEnvFileOwner } from "./RuntimeEnvFile.ts";

const stackId = StackIdSchema.make("e".repeat(64));

const withPlatform = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(effect).pipe(Effect.provide(NodeServices.layer));

const setupEnvOwner = (prefix: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix });
    const owner = yield* makeRuntimeEnvFileOwner({ stateRoot: root, stackId });
    return { fs, root, owner };
  });

describe("runtime environment file owner", () => {
  it.live("writes deterministic owner-only session files", () =>
    withPlatform(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const { fs, owner } = yield* setupEnvOwner("stack-env-");
        const first = yield* owner.write({
          workloadId: "database:database",
          values: { Z_LAST: "two", A_FIRST: "one" },
        });
        expect(yield* fs.readFileString(first)).toBe("A_FIRST=one\nZ_LAST=two\n");
        expect((yield* fs.stat(first)).mode & 0o777).toBe(0o600);
        expect((yield* fs.stat(path.dirname(first))).mode & 0o777).toBe(0o700);
      }),
    ),
  );

  it.live("replaces one workload file without changing its path", () =>
    withPlatform(
      Effect.gen(function* () {
        const { fs, owner } = yield* setupEnvOwner("stack-env-replace-");
        const first = yield* owner.write({
          workloadId: "database:database",
          values: { A_FIRST: "one" },
        });
        const second = yield* owner.write({
          workloadId: "database:database",
          values: { A_FIRST: "updated" },
        });
        expect(second).toBe(first);
        expect(yield* fs.readFileString(second)).toBe("A_FIRST=updated\n");
      }),
    ),
  );

  it.live("rejects unsafe values without revealing the value", () =>
    withPlatform(
      Effect.gen(function* () {
        const { fs, root, owner } = yield* setupEnvOwner("stack-env-invalid-");
        const secret = "very-secret-value";
        const invalid = yield* owner
          .write({
            workloadId: "database:database",
            values: { VALID: `${secret}\nINJECTED` },
          })
          .pipe(Effect.exit);
        expect(Exit.isFailure(invalid)).toBe(true);
        if (Exit.isFailure(invalid)) expect(String(invalid.cause)).not.toContain(secret);
        expect(yield* fs.exists(`${root}/${stackId}/runtime/env`)).toBe(false);
      }),
    ),
  );

  it.live("rejects invalid environment variable names", () =>
    withPlatform(
      Effect.gen(function* () {
        const { owner } = yield* setupEnvOwner("stack-env-invalid-name-");
        const invalid = yield* owner
          .write({ workloadId: "database:database", values: { "BAD-NAME": "ok" } })
          .pipe(Effect.exit);
        expect(Exit.isFailure(invalid)).toBe(true);
      }),
    ),
  );

  it.live("rejects workload identities that could escape the env root", () =>
    withPlatform(
      Effect.gen(function* () {
        const { owner } = yield* setupEnvOwner("stack-env-invalid-workload-");
        const invalid = yield* owner
          .write({ workloadId: "../escape", values: { SAFE: "ok" } })
          .pipe(Effect.exit);
        expect(Exit.isFailure(invalid)).toBe(true);
      }),
    ),
  );

  it.live("cleans exact session files idempotently", () =>
    withPlatform(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const { fs, root, owner } = yield* setupEnvOwner("stack-env-cleanup-");
        const file = yield* owner.write({
          workloadId: "rest:rest",
          values: { X: "y" },
        });

        expect(yield* fs.exists(file)).toBe(true);

        yield* owner.cleanupAll;

        expect(yield* fs.exists(file)).toBe(false);
        expect(yield* fs.exists(path.join(root, stackId, "runtime", "env"))).toBe(false);
        yield* owner.cleanupAll;
      }),
    ),
  );

  it.live("recreates a workload file after cleanup", () =>
    withPlatform(
      Effect.gen(function* () {
        const { fs, owner } = yield* setupEnvOwner("stack-env-recreate-");
        const original = yield* owner.write({ workloadId: "rest:rest", values: { X: "y" } });
        expect(yield* fs.exists(original)).toBe(true);
        yield* owner.cleanupAll;
        expect(yield* fs.exists(original)).toBe(false);
        const recreated = yield* owner.write({ workloadId: "rest:rest", values: { X: "z" } });
        expect(yield* fs.readFileString(recreated)).toBe("X=z\n");
      }),
    ),
  );

  it.live("keeps concurrent workload files collision-free", () =>
    withPlatform(
      Effect.gen(function* () {
        const { fs, owner } = yield* setupEnvOwner("stack-env-concurrent-");
        const files = yield* Effect.all(
          [
            owner.write({ workloadId: "rest:rest", values: { A: "one" } }),
            owner.write({ workloadId: "auth:auth", values: { B: "two" } }),
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
