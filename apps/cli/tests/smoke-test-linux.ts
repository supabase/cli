import { $ } from "bun";
import { BunPath } from "@effect/platform-bun";
import { Effect } from "effect";
import * as EffectPath from "effect/Path";
import process from "node:process";
import { parseArgs } from "node:util";
import { describeError, runNpmTest } from "./helpers/npm-registry.ts";
import { verifyExpectedShell } from "./helpers/release-shell.ts";

const { values } = parseArgs({
  options: {
    version: { type: "string", default: "0.0.1-smoke" },
    tag: { type: "string", default: "latest" },
  },
});

const { resolve, join } = Effect.runSync(EffectPath.Path.pipe(Effect.provide(BunPath.layer)));
const log = (message: string): void => Effect.runSync(Effect.log(message));
const logError = (message: string): void => Effect.runSync(Effect.logError(message));

const version = values.version!;
const tag = values.tag;
if (tag !== "latest" && tag !== "alpha" && tag !== "beta") {
  logError(`Invalid --tag value: ${String(tag)}. Expected "latest", "alpha", or "beta".`);
  process.exit(1);
}
const root = resolve(import.meta.dir, "../../..");
const distDir = join(root, "dist");

const dispatchProbe = "supabase init --help 2>&1 | grep -q init";

interface TestResult {
  name: string;
  status: "pass" | "fail";
}

const results: TestResult[] = [];

// --- Native ---

log(`\n${"=".repeat(60)}`);
log("Native binary tests");
log("=".repeat(60));

{
  const arch = process.arch; // "x64" or "arm64"
  const name = `native-linux-${arch}`;
  const binPath = join(root, "packages", `cli-linux-${arch}`, "bin", "supabase");

  log(`[${name}] Running ${binPath} --version...`);
  try {
    const output = await $`${binPath} --version`.text();
    const trimmed = output.trim();
    const shellCheck = await verifyExpectedShell(binPath);
    const passed = /^\d+\.\d+\.\d+/.test(trimmed) && shellCheck.passed;
    log(`[${name}] ${passed ? "PASS" : "FAIL"} — ${trimmed}`);
    log(`[${name}] ${shellCheck.detail}`);
    results.push({ name, status: passed ? "pass" : "fail" });
  } catch (e) {
    log(`[${name}] FAIL —\n${describeError(e)}`);
    results.push({ name, status: "fail" });
  }
}

// --- Docker ---

log(`\n${"=".repeat(60)}`);
log("Docker-based Linux package tests");
log("=".repeat(60));

const hasDocker = await $`docker --version`.quiet().then(
  () => true,
  () => false,
);

if (!hasDocker) {
  log("[docker] SKIP — docker not found");
} else {
  interface DockerResult {
    name: string;
    passed: boolean;
    output: string;
  }

  function runDockerTest(
    name: string,
    image: string,
    platform: string,
    commands: string,
  ): Promise<DockerResult> {
    log(`[${name}] Running...`);
    const runAttempt = (attempt: number): Promise<DockerResult> =>
      $`docker run --rm --platform ${platform} -v ${distDir}:/dist:ro ${image} sh -c ${commands}`
        .nothrow()
        .quiet()
        .then((result) => {
          const stdout = result.stdout.toString().trim();
          const stderr = result.stderr.toString().trim();
          if (result.exitCode === 0) {
            const lastLine = stdout.split("\n").pop() ?? "";
            const passed = /^\d+\.\d+\.\d+/.test(lastLine);
            log(`[${name}] ${passed ? "PASS" : "FAIL"} — ${lastLine}`);
            if (!passed && stderr) log(`[${name}] stderr: ${stderr}`);
            return { name, passed, output: stdout };
          }
          // Exit 125 is a docker daemon / container-start error, not a container
          // exit code. Retry once before giving up.
          if (result.exitCode === 125 && attempt === 1) {
            log(`[${name}] docker exit 125, retrying once. stderr: ${stderr}`);
            return runAttempt(2);
          }
          log(`[${name}] FAIL — exit ${result.exitCode}`);
          if (stderr) log(`[${name}] stderr: ${stderr}`);
          if (stdout) log(`[${name}] stdout: ${stdout}`);
          return { name, passed: false, output: `${stdout}\n${stderr}`.trim() };
        });
    return runAttempt(1);
  }

  const jobs: Promise<DockerResult>[] = [];

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

  const dockerResults = await Promise.all(jobs);
  for (const r of dockerResults) {
    results.push({ name: r.name, status: r.passed ? "pass" : "fail" });
  }
}

// --- npm ---

log(`\n${"=".repeat(60)}`);
log("npm (Verdaccio) test");
log("=".repeat(60));

try {
  const npmPassed = await runNpmTest(version, tag);
  results.push({ name: "npm", status: npmPassed ? "pass" : "fail" });
} catch (e) {
  logError(`[npm] Error:\n${describeError(e)}`);
  results.push({ name: "npm", status: "fail" });
}

// --- Summary ---

log(`\n${"=".repeat(60)}`);
log("Linux Smoke Test Summary");
log("=".repeat(60));

for (const r of results) {
  log(`  ${r.status === "pass" ? "PASS" : "FAIL"}  ${r.name}`);
}

const passed = results.filter((r) => r.status === "pass").length;
const failed = results.filter((r) => r.status === "fail").length;

log(`\n${passed} passed, ${failed} failed out of ${results.length} tests`);

if (failed > 0) {
  process.exit(1);
}
