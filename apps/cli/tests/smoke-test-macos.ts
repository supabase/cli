import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { $ } from "bun";
import { Cause, Console, Data, Effect, Exit, FileSystem, Layer, Path, Predicate } from "effect";
import process from "node:process";
import { parseArgs } from "node:util";
import { isPublishableNpmTag, PUBLISHABLE_NPM_TAGS_HINT } from "../scripts/release-channels.ts";
import { verifyMacSignature } from "./helpers/macos-signature.ts";
import { createTmpDir, describeError, runNpmTest } from "./helpers/npm-registry.ts";
import { releaseStep, verifyExpectedShellEffect } from "./helpers/release-shell.ts";

const { values } = parseArgs({
  options: {
    version: { type: "string", default: "0.0.1-smoke" },
    tag: { type: "string", default: "latest" },
  },
});

const version = values.version!;
const tag = values.tag;

/** Removing the tap failed after the brew steps had already failed; both causes are kept. */
class TapDisposalSuppressed extends Data.TaggedError("TapDisposalSuppressed")<{
  readonly error: Cause.Cause<unknown>;
  readonly suppressed: Cause.Cause<unknown>;
}> {}

/* What a brew step reports: the wrapped error, or a SuppressedError as `await using` builds. */
function thrownValue(failure: unknown): unknown {
  if (failure instanceof TapDisposalSuppressed) {
    return new SuppressedError(
      thrownValue(Cause.squash(failure.error)),
      thrownValue(Cause.squash(failure.suppressed)),
    );
  }
  if (
    (Predicate.isTagged(failure, "ReleaseStepError") ||
      Predicate.isTagged(failure, "PlatformError")) &&
    Predicate.hasProperty(failure, "cause")
  ) {
    return failure.cause;
  }
  return failure;
}

/** `try { body } finally { cleanup }`: a cleanup failure replaces the body's outcome. */
const withFinally = <A, E, R, E2, R2>(
  body: Effect.Effect<A, E, R>,
  cleanup: Effect.Effect<unknown, E2, R2>,
): Effect.Effect<A, E | E2, R | R2> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(restore(body));
      yield* cleanup;
      return yield* exit;
    }),
  );

const main = Effect.gen(function* () {
  if (!isPublishableNpmTag(tag)) {
    yield* Console.error(
      `Invalid --tag value: ${String(tag)}. Expected ${PUBLISHABLE_NPM_TAGS_HINT}.`,
    );
    return yield* Effect.sync(() => process.exit(1));
  }
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = path.resolve(import.meta.dir, "../../..");

  interface TestResult {
    name: string;
    status: "pass" | "fail";
  }

  const results: TestResult[] = [];

  yield* Console.log(`\n${"=".repeat(60)}`);
  yield* Console.log("Native binary tests");
  yield* Console.log("=".repeat(60));

  {
    const arch = process.arch;
    const name = `native-darwin-${arch}`;
    const binPath = path.join(root, "packages", `cli-darwin-${arch}`, "bin", "supabase");

    yield* Console.log(`[${name}] Running ${binPath} --version...`);
    yield* Effect.gen(function* () {
      const output = yield* releaseStep(() => $`${binPath} --version`.text());
      const trimmed = output.trim();
      const shellCheck = yield* verifyExpectedShellEffect(binPath);
      const passed = /^\d+\.\d+\.\d+/.test(trimmed) && shellCheck.passed;
      yield* Console.log(`[${name}] ${passed ? "PASS" : "FAIL"} — ${trimmed}`);
      yield* Console.log(`[${name}] ${shellCheck.detail}`);
      results.push({ name, status: passed ? "pass" : "fail" });
    }).pipe(
      Effect.catch((e) =>
        Effect.gen(function* () {
          yield* Console.log(`[${name}] FAIL —\n${describeError(e.cause)}`);
          results.push({ name, status: "fail" });
        }),
      ),
    );
  }

  {
    const arch = process.arch;
    const binDir = path.join(root, "packages", `cli-darwin-${arch}`, "bin");
    const binaries = ["supabase"];
    if (
      yield* fs.exists(path.join(binDir, "supabase-go")).pipe(Effect.orElseSucceed(() => false))
    ) {
      binaries.push("supabase-go");
    }

    for (const binary of binaries) {
      const name = `native-darwin-${arch}-signature-${binary}`;
      const binPath = path.join(binDir, binary);
      yield* Console.log(`[${name}] Verifying signature of ${binPath}...`);
      yield* Effect.gen(function* () {
        const sig = yield* verifyMacSignature(binPath);
        yield* Console.log(`[${name}] ${sig.passed ? "PASS" : "FAIL"} — ${sig.detail}`);
        results.push({ name, status: sig.passed ? "pass" : "fail" });
      }).pipe(
        Effect.catch((e) =>
          Effect.gen(function* () {
            yield* Console.log(`[${name}] FAIL —\n${describeError(e.cause)}`);
            results.push({ name, status: "fail" });
          }),
        ),
      );
    }
  }

  yield* Console.log(`\n${"=".repeat(60)}`);
  yield* Console.log("npm (Verdaccio) test");
  yield* Console.log("=".repeat(60));

  yield* Effect.gen(function* () {
    const npmPassed = yield* releaseStep(() => runNpmTest(version, tag));
    results.push({ name: "npm", status: npmPassed ? "pass" : "fail" });
  }).pipe(
    Effect.catch((e) =>
      Effect.gen(function* () {
        yield* Console.error(`[npm] Error:\n${describeError(e.cause)}`);
        results.push({ name: "npm", status: "fail" });
      }),
    ),
  );

  yield* Console.log(`\n${"=".repeat(60)}`);
  yield* Console.log("Homebrew test");
  yield* Console.log("=".repeat(60));

  const hasBrew = yield* releaseStep(() => $`brew --version`.quiet()).pipe(
    Effect.match({
      onSuccess: () => true,
      onFailure: () => false,
    }),
  );

  if (!hasBrew) {
    yield* Console.log("[brew] SKIP — brew not found");
  } else {
    yield* Effect.gen(function* () {
      yield* Console.log("Generating Homebrew formula...");
      yield* releaseStep(() =>
        $`bun run apps/cli/scripts/update-homebrew.ts --version ${version} --local`.cwd(root),
      );

      // Create a local git-backed tap
      const useTap = (tap: AsyncDisposable & { path: string }) =>
        Effect.gen(function* () {
          yield* fs.makeDirectory(path.join(tap.path, "Formula"));
          yield* releaseStep(
            () =>
              $`cp ${path.join(root, "dist", "supabase.rb")} ${path.join(tap.path, "Formula", "supabase.rb")}`,
          );
          yield* releaseStep(() => $`git -C ${tap.path} init`.quiet());
          yield* releaseStep(() => $`git -C ${tap.path} add .`.quiet());
          yield* releaseStep(() => $`git -C ${tap.path} commit -m init`.quiet());

          yield* Console.log("Installing via Homebrew...");
          yield* releaseStep(() => $`brew tap --force supabase/test-tap ${tap.path}`);

          yield* withFinally(
            Effect.gen(function* () {
              yield* releaseStep(() => $`brew install supabase/test-tap/supabase`);

              const output = yield* releaseStep(() => $`supabase --version`.text());
              const trimmed = output.trim();
              const shellCheck = yield* verifyExpectedShellEffect("supabase");
              const passed = /^\d+\.\d+\.\d+/.test(trimmed) && shellCheck.passed;

              yield* Console.log(
                `[brew] ${passed ? "PASS" : "FAIL"} — supabase --version: ${trimmed}`,
              );
              yield* Console.log(`[brew] ${shellCheck.detail}`);
              results.push({ name: "brew", status: passed ? "pass" : "fail" });
            }),
            Effect.gen(function* () {
              yield* releaseStep(() => $`brew uninstall supabase`.nothrow());
              yield* releaseStep(() => $`brew untap supabase/test-tap`.nothrow());
            }),
          );
        });
      /* `await using tap`: a failed removal replaces the outcome, or suppresses a failed one. */
      yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const tap = yield* releaseStep(() => createTmpDir("brew-smoke-"));
          const used = yield* Effect.exit(restore(useTap(tap)));
          const disposed = yield* Effect.exit(releaseStep(() => tap[Symbol.asyncDispose]()));
          if (Exit.isFailure(disposed) && Exit.isFailure(used)) {
            /* An interrupted use keeps its interruption, with the removal failure alongside. */
            return yield* Cause.hasInterrupts(used.cause)
              ? Effect.failCause(Cause.combine(used.cause, disposed.cause))
              : Effect.fail(
                  new TapDisposalSuppressed({ error: disposed.cause, suppressed: used.cause }),
                );
          }
          yield* disposed;
          return yield* used;
        }),
      );
    }).pipe(
      Effect.catch((e) =>
        Effect.gen(function* () {
          yield* Console.error(`[brew] Error:\n${describeError(thrownValue(e))}`);
          results.push({ name: "brew", status: "fail" });
        }),
      ),
    );
  }

  yield* Console.log(`\n${"=".repeat(60)}`);
  yield* Console.log("macOS Smoke Test Summary");
  yield* Console.log("=".repeat(60));

  for (const r of results) {
    yield* Console.log(`  ${r.status === "pass" ? "PASS" : "FAIL"}  ${r.name}`);
  }

  const passed = results.filter((r) => r.status === "pass").length;
  const failed = results.filter((r) => r.status === "fail").length;

  yield* Console.log(`\n${passed} passed, ${failed} failed out of ${results.length} tests`);

  if (failed > 0) {
    return yield* Effect.sync(() => process.exit(1));
  }
});

await Effect.runPromise(
  main.pipe(Effect.provide(Layer.mergeAll(BunFileSystem.layer, BunPath.layer))),
);
