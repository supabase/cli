import { $ } from "bun";
import process from "node:process";
import { parseArgs } from "node:util";
import { BunServices } from "@effect/platform-bun";
import { Data, Effect, FileSystem, Path } from "effect";
import { verifyExpectedShell } from "./helpers/release-shell.ts";

class SmokeError extends Data.TaggedError("SmokeError")<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

const errorMessage = (error: unknown) =>
  error instanceof SmokeError
    ? `${error.operation}: ${error.cause instanceof Error ? error.cause.message : String(error.cause)}`
    : error instanceof Error
      ? error.message
      : String(error);

const runForeign = <A>(operation: string, promise: () => PromiseLike<A>) =>
  Effect.tryPromise({
    try: promise,
    catch: (cause) => new SmokeError({ operation, cause }),
  });

const { values } = parseArgs({
  options: {
    version: { type: "string", default: "0.0.1-smoke" },
    tag: { type: "string", default: "latest" },
  },
});

const version = values.version ?? "0.0.1-smoke";
const tag = values.tag;

interface TestResult {
  readonly name: string;
  readonly status: "pass" | "fail";
}

const main = Effect.gen(function* () {
  const path = yield* Path.Path;
  const fileSystem = yield* FileSystem.FileSystem;
  const root = path.resolve(import.meta.dir, "../../..");
  const results: Array<TestResult> = [];

  const log = (message: string) =>
    Effect.sync(() => {
      process.stdout.write(`${message}\n`);
    });
  const logError = (message: string) =>
    Effect.sync(() => {
      process.stderr.write(`${message}\n`);
    });
  const gitBashPath = (filePath: string) =>
    process.platform === "win32"
      ? runForeign("cygpath", () => $`cygpath -u ${filePath}`.text()).pipe(
          Effect.map((value) => value.trim()),
        )
      : Effect.succeed(filePath);

  const runCase = <A extends { readonly passed: boolean; readonly detail: string }>(
    name: string,
    effect: Effect.Effect<A, SmokeError>,
  ) =>
    Effect.gen(function* () {
      const result = yield* effect.pipe(
        Effect.match({
          onFailure: (error) => ({
            passed: false,
            detail: `${error.operation}: ${error.cause instanceof Error ? error.cause.message : String(error.cause)}`,
          }),
          onSuccess: (value) => value,
        }),
      );
      yield* log(`[${name}] ${result.passed ? "PASS" : "FAIL"} — ${result.detail}`);
      results.push({ name, status: result.passed ? "pass" : "fail" });
    });

  const checkBinary = (binPath: string) =>
    Effect.gen(function* () {
      const output = yield* runForeign("binary --version", () => $`${binPath} --version`.text());
      const trimmed = output.trim();
      const shellCheck = yield* runForeign("verify expected shell", () =>
        verifyExpectedShell(binPath),
      );
      return {
        passed: /^\d+\.\d+\.\d+/.test(trimmed) && shellCheck.passed,
        detail: `${trimmed} (${shellCheck.detail})`,
      };
    });

  if (tag !== "latest" && tag !== "alpha" && tag !== "beta") {
    yield* logError(`Invalid --tag value: ${String(tag)}. Expected "latest", "alpha", or "beta".`);
    return 1;
  }

  yield* log(`\n${"=".repeat(60)}`);
  yield* log("Native binary tests");
  yield* log("=".repeat(60));

  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const nativeName = `native-windows-${arch}`;
  const nativePath = path.join(root, "packages", `cli-windows-${arch}`, "bin", "supabase.exe");
  yield* log(`[${nativeName}] Running ${nativePath} --version...`);
  yield* runCase(nativeName, checkBinary(nativePath));

  yield* log(`\n${"=".repeat(60)}`);
  yield* log("Release tarball test");
  yield* log("=".repeat(60));

  const archiveArch = arch === "arm64" ? "arm64" : "amd64";
  const archiveName = `windows-${archiveArch}-tarball`;
  const archivePath = path.join(root, "dist", `supabase_${version}_windows_${archiveArch}.tar.gz`);
  const extractDir = yield* Effect.acquireRelease(
    fileSystem.makeTempDirectory({ prefix: "supabase-windows-tarball-" }),
    (directory) =>
      fileSystem.remove(directory, { recursive: true, force: true }).pipe(Effect.ignore),
  );
  yield* log(`[${archiveName}] Extracting ${archivePath}...`);
  yield* runCase(
    archiveName,
    Effect.gen(function* () {
      const archive = yield* gitBashPath(archivePath);
      const destination = yield* gitBashPath(extractDir);
      yield* runForeign("tar extraction", () => $`tar -xzf ${archive} -C ${destination}`);
      const binPath = path.join(extractDir, "supabase.exe");
      return yield* checkBinary(binPath);
    }),
  );

  yield* log(`\n${"=".repeat(60)}`);
  yield* log("Scoop test");
  yield* log("=".repeat(60));

  const hasScoop = yield* runForeign("scoop --version", () => $`scoop --version`.quiet()).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );
  if (!hasScoop) {
    yield* log("[scoop] SKIP — scoop not found");
  } else {
    const manifest = path.join(root, "dist", "supabase.json");
    yield* Effect.acquireUseRelease(
      Effect.gen(function* () {
        yield* log("Generating Scoop manifest...");
        yield* runForeign("generate Scoop manifest", () =>
          $`bun run apps/cli/scripts/update-scoop.ts --version ${version} --local`.cwd(root),
        );
        yield* log("Installing via Scoop...");
        yield* runForeign("scoop install", () => $`scoop install ${manifest}`);
      }),
      () =>
        runCase(
          "scoop",
          Effect.gen(function* () {
            const output = yield* runForeign("supabase --version", () =>
              $`supabase --version`.text(),
            );
            const trimmed = output.trim();
            const shellCheck = yield* runForeign("verify expected shell", () =>
              verifyExpectedShell("supabase"),
            );
            return {
              passed: /^\d+\.\d+\.\d+/.test(trimmed) && shellCheck.passed,
              detail: `${trimmed} (${shellCheck.detail})`,
            };
          }),
        ),
      () =>
        runForeign("scoop uninstall", () => $`scoop uninstall supabase`.nothrow()).pipe(
          Effect.asVoid,
        ),
    );
  }

  yield* log(`\n${"=".repeat(60)}`);
  yield* log("Windows Smoke Test Summary");
  yield* log("=".repeat(60));
  for (const result of results) {
    yield* log(`  ${result.status === "pass" ? "PASS" : "FAIL"}  ${result.name}`);
  }
  const passed = results.filter((result) => result.status === "pass").length;
  const failed = results.filter((result) => result.status === "fail").length;
  yield* log(`\n${passed} passed, ${failed} failed out of ${results.length} tests`);
  return failed > 0 ? 1 : 0;
});

Effect.runPromise(Effect.scoped(main).pipe(Effect.provide(BunServices.layer))).then(
  (exitCode) => {
    process.exitCode = exitCode;
  },
  (error: unknown) => {
    Effect.runSync(
      Effect.sync(() => {
        process.stderr.write(`${errorMessage(error)}\n`);
      }),
    );
    process.exitCode = 1;
  },
);
