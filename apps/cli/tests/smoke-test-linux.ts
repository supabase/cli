import { BunPath } from "@effect/platform-bun";
import { $ } from "bun";
import { Console, Effect, Path } from "effect";
import process from "node:process";
import { parseArgs } from "node:util";
import { isPublishableNpmTag, PUBLISHABLE_NPM_TAGS_HINT } from "../scripts/release-channels.ts";
import { describeError, runNpmTest } from "./helpers/npm-registry.ts";
import {
  type ReleaseStepError,
  releaseStep,
  verifyExpectedShellEffect,
} from "./helpers/release-shell.ts";

const { values } = parseArgs({
  options: {
    version: { type: "string", default: "0.0.1-smoke" },
    tag: { type: "string", default: "latest" },
  },
});

const version = values.version!;
const tag = values.tag;

const main = Effect.gen(function* () {
  if (!isPublishableNpmTag(tag)) {
    yield* Console.error(
      `Invalid --tag value: ${String(tag)}. Expected ${PUBLISHABLE_NPM_TAGS_HINT}.`,
    );
    return yield* Effect.sync(() => process.exit(1));
  }
  const path = yield* Path.Path;
  const root = path.resolve(import.meta.dir, "../../..");
  const distDir = path.join(root, "dist");

  const dispatchProbe = "supabase init --help 2>&1 | grep -q init";

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
    const name = `native-linux-${arch}`;
    const binPath = path.join(root, "packages", `cli-linux-${arch}`, "bin", "supabase");

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

  yield* Console.log(`\n${"=".repeat(60)}`);
  yield* Console.log("Docker-based Linux package tests");
  yield* Console.log("=".repeat(60));

  const hasDocker = yield* releaseStep(() => $`docker --version`.quiet()).pipe(
    Effect.match({
      onSuccess: () => true,
      onFailure: () => false,
    }),
  );

  if (!hasDocker) {
    yield* Console.log("[docker] SKIP — docker not found");
  } else {
    interface DockerResult {
      name: string;
      passed: boolean;
      output: string;
    }

    const runDockerTest = Effect.fnUntraced(function* (
      name: string,
      image: string,
      platform: string,
      commands: string,
    ) {
      yield* Console.log(`[${name}] Running...`);
      for (let attempt = 1; attempt <= 2; attempt++) {
        const result = yield* releaseStep(() =>
          $`docker run --rm --platform ${platform} -v ${distDir}:/dist:ro ${image} sh -c ${commands}`
            .nothrow()
            .quiet(),
        );
        const stdout = result.stdout.toString().trim();
        const stderr = result.stderr.toString().trim();
        if (result.exitCode === 0) {
          const lastLine = stdout.split("\n").pop() ?? "";
          const passed = /^\d+\.\d+\.\d+/.test(lastLine);
          yield* Console.log(`[${name}] ${passed ? "PASS" : "FAIL"} — ${lastLine}`);
          if (!passed && stderr) yield* Console.log(`[${name}] stderr: ${stderr}`);
          return { name, passed, output: stdout };
        }
        // Exit 125 is a docker daemon / container-start error, not a container
        // exit code. Retry once before giving up.
        if (result.exitCode === 125 && attempt === 1) {
          yield* Console.log(`[${name}] docker exit 125, retrying once. stderr: ${stderr}`);
          continue;
        }
        yield* Console.log(`[${name}] FAIL — exit ${result.exitCode}`);
        if (stderr) yield* Console.log(`[${name}] stderr: ${stderr}`);
        if (stdout) yield* Console.log(`[${name}] stdout: ${stdout}`);
        return { name, passed: false, output: `${stdout}\n${stderr}`.trim() };
      }
      return { name, passed: false, output: "unreachable" };
    });

    const jobs: Effect.Effect<DockerResult, ReleaseStepError>[] = [];

    for (const arch of ["arm64", "amd64"] as const) {
      const dockerPlatform = `linux/${arch}`;

      jobs.push(
        runDockerTest(
          `linux-${arch}-tarball`,
          "debian:bookworm-slim",
          dockerPlatform,
          `tar -xzf /dist/supabase_${version}_linux_${arch}.tar.gz -C /usr/local/bin && supabase --version && ${dispatchProbe}`,
        ),
      );

      jobs.push(
        runDockerTest(
          `linux-${arch}-deb`,
          "debian:bookworm-slim",
          dockerPlatform,
          `dpkg -i /dist/supabase_${version}_linux_${arch}.deb && supabase --version && ${dispatchProbe}`,
        ),
      );

      jobs.push(
        runDockerTest(
          `linux-${arch}-rpm`,
          "amazonlinux:2023",
          dockerPlatform,
          `rpm -ivh /dist/supabase_${version}_linux_${arch}.rpm && supabase --version && ${dispatchProbe}`,
        ),
      );

      jobs.push(
        runDockerTest(
          `linux-${arch}-apk`,
          "alpine:3.21",
          dockerPlatform,
          `apk add --allow-untrusted /dist/supabase_${version}_linux_${arch}.apk && supabase --version && ${dispatchProbe}`,
        ),
      );
    }

    const dockerResults = yield* Effect.all(jobs, { concurrency: "unbounded" });
    for (const r of dockerResults) {
      results.push({ name: r.name, status: r.passed ? "pass" : "fail" });
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
  yield* Console.log("Linux Smoke Test Summary");
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
    Effect.provide(BunPath.layer),
  ),
);
