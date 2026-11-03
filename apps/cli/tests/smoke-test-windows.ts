import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { $ } from "bun";
import { Console, Effect, FileSystem, Layer, Path } from "effect";
import process from "node:process";
import { parseArgs } from "node:util";
import { isPublishableNpmTag, PUBLISHABLE_NPM_TAGS_HINT } from "../scripts/release-channels.ts";
import { releaseStep, verifyExpectedShellEffect } from "./helpers/release-shell.ts";

const { values } = parseArgs({
  options: {
    version: { type: "string", default: "0.0.1-smoke" },
    tag: { type: "string", default: "latest" },
  },
});

const version = values.version!;
const tag = values.tag;

const gitBashPath = Effect.fnUntraced(function* (filePath: string) {
  return process.platform === "win32"
    ? (yield* releaseStep(() => $`cygpath -u ${filePath}`.text())).trim()
    : filePath;
});

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

  const arch = process.arch === "arm64" ? "arm64" : "x64";

  {
    const name = `native-windows-${arch}`;
    const binPath = path.join(root, "packages", `cli-windows-${arch}`, "bin", "supabase.exe");

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
          yield* Console.log(`[${name}] FAIL — ${e.cause}`);
          results.push({ name, status: "fail" });
        }),
      ),
    );
  }

  yield* Console.log(`\n${"=".repeat(60)}`);
  yield* Console.log("Release tarball test");
  yield* Console.log("=".repeat(60));

  {
    const archiveArch = arch === "arm64" ? "arm64" : "amd64";
    const name = `windows-${archiveArch}-tarball`;
    const archivePath = path.join(
      root,
      "dist",
      `supabase_${version}_windows_${archiveArch}.tar.gz`,
    );
    const extractDir = yield* fs.makeTempDirectory({ prefix: "supabase-windows-tarball-" });

    yield* Console.log(`[${name}] Extracting ${archivePath}...`);
    yield* Effect.onExit(
      Effect.gen(function* () {
        const archiveBashPath = yield* gitBashPath(archivePath);
        const extractBashPath = yield* gitBashPath(extractDir);
        yield* releaseStep(() => $`tar -xzf ${archiveBashPath} -C ${extractBashPath}`);
        const binPath = path.join(extractDir, "supabase.exe");
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
            yield* Console.error(`[${name}] Error: ${e.cause}`);
            results.push({ name, status: "fail" });
          }),
        ),
      ),
      () => fs.remove(extractDir, { recursive: true, force: true }),
    );
  }

  yield* Console.log(`\n${"=".repeat(60)}`);
  yield* Console.log("Scoop test");
  yield* Console.log("=".repeat(60));

  const hasScoop = yield* releaseStep(() => $`scoop --version`.quiet()).pipe(
    Effect.match({
      onSuccess: () => true,
      onFailure: () => false,
    }),
  );

  if (!hasScoop) {
    yield* Console.log("[scoop] SKIP — scoop not found");
  } else {
    const manifest = path.join(root, "dist", "supabase.json");

    yield* Effect.gen(function* () {
      yield* Console.log("Generating Scoop manifest...");
      yield* releaseStep(() =>
        $`bun run apps/cli/scripts/update-scoop.ts --version ${version} --local`.cwd(root),
      );

      yield* Console.log("Installing via Scoop...");
      yield* releaseStep(() => $`scoop install ${manifest}`);

      yield* withFinally(
        Effect.gen(function* () {
          const output = yield* releaseStep(() => $`supabase --version`.text());
          const trimmed = output.trim();
          const shellCheck = yield* verifyExpectedShellEffect("supabase");
          const passed = /^\d+\.\d+\.\d+/.test(trimmed) && shellCheck.passed;

          yield* Console.log(
            `[scoop] ${passed ? "PASS" : "FAIL"} — supabase --version: ${trimmed}`,
          );
          yield* Console.log(`[scoop] ${shellCheck.detail}`);
          results.push({ name: "scoop", status: passed ? "pass" : "fail" });
        }),
        releaseStep(() => $`scoop uninstall supabase`.nothrow()),
      );
    }).pipe(
      Effect.catch((e) =>
        Effect.gen(function* () {
          yield* Console.error(`[scoop] Error: ${e.cause}`);
          results.push({ name: "scoop", status: "fail" });
        }),
      ),
    );
  }

  yield* Console.log(`\n${"=".repeat(60)}`);
  yield* Console.log("Windows Smoke Test Summary");
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
  main.pipe(
    Effect.catch((e) => Effect.die(e.cause)),
    Effect.provide(Layer.mergeAll(BunFileSystem.layer, BunPath.layer)),
  ),
);
