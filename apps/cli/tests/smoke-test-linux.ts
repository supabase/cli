import { $ } from "bun";
import path from "node:path";
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

const version = values.version!;
const tag = values.tag;
if (tag !== "latest" && tag !== "alpha" && tag !== "beta") {
  console.error(`Invalid --tag value: ${String(tag)}. Expected "latest", "alpha", or "beta".`);
  process.exit(1);
}
const root = path.resolve(import.meta.dir, "../../..");
const distDir = path.join(root, "dist");

const dispatchProbe = "supabase init --help 2>&1 | grep -q init";

interface TestResult {
  name: string;
  status: "pass" | "fail";
}

const results: TestResult[] = [];

// --- Native ---

console.log(`\n${"=".repeat(60)}`);
console.log("Native binary tests");
console.log("=".repeat(60));

{
  const arch = process.arch; // "x64" or "arm64"
  const name = `native-linux-${arch}`;
  const binPath = path.join(root, "packages", `cli-linux-${arch}`, "bin", "supabase");

  console.log(`[${name}] Running ${binPath} --version...`);
  try {
    const output = await $`${binPath} --version`.text();
    const trimmed = output.trim();
    const shellCheck = await verifyExpectedShell(binPath);
    const passed = /^\d+\.\d+\.\d+/.test(trimmed) && shellCheck.passed;
    console.log(`[${name}] ${passed ? "PASS" : "FAIL"} — ${trimmed}`);
    console.log(`[${name}] ${shellCheck.detail}`);
    results.push({ name, status: passed ? "pass" : "fail" });
  } catch (e) {
    console.log(`[${name}] FAIL —\n${describeError(e)}`);
    results.push({ name, status: "fail" });
  }
}

// --- Docker ---

console.log(`\n${"=".repeat(60)}`);
console.log("Docker-based Linux package tests");
console.log("=".repeat(60));

const hasDocker = await $`docker --version`.quiet().then(
  () => true,
  () => false,
);

if (!hasDocker) {
  console.log("[docker] SKIP — docker not found");
} else {
  interface DockerResult {
    name: string;
    passed: boolean;
    output: string;
  }

  // Docker daemon exit code (125) and connection-reset-style failures (1) during
  // image pulls are flaky on shared CI runners under parallel load. Retry once
  // before giving up.
  const TRANSIENT_DOCKER_EXIT_CODES = new Set([1, 125]);

  function getExitCode(e: unknown): number | undefined {
    if (e !== null && typeof e === "object" && "exitCode" in e && typeof e.exitCode === "number") {
      return e.exitCode;
    }
    return undefined;
  }

  async function runDockerOnce(
    image: string,
    platform: string,
    commands: string,
  ): Promise<{ ok: true; output: string } | { ok: false; exitCode: number; detail: string }> {
    try {
      const output =
        await $`docker run --rm --platform ${platform} -v ${distDir}:/dist:ro ${image} sh -c ${commands}`.text();
      return { ok: true, output: output.trim() };
    } catch (e) {
      return { ok: false, exitCode: getExitCode(e) ?? -1, detail: describeError(e) };
    }
  }

  async function runDockerTest(
    name: string,
    image: string,
    platform: string,
    commands: string,
  ): Promise<DockerResult> {
    console.log(`[${name}] Running...`);
    let attempt = 0;
    let lastDetail = "";
    while (attempt < 2) {
      attempt += 1;
      const result = await runDockerOnce(image, platform, commands);
      if (result.ok) {
        const lastLine = result.output.split("\n").pop()!;
        const passed = /^\d+\.\d+\.\d+/.test(lastLine);
        console.log(`[${name}] ${passed ? "PASS" : "FAIL"} — ${lastLine}`);
        return { name, passed, output: result.output };
      }
      lastDetail = result.detail;
      if (!TRANSIENT_DOCKER_EXIT_CODES.has(result.exitCode) || attempt >= 2) {
        console.log(`[${name}] FAIL —\n${lastDetail}`);
        return { name, passed: false, output: lastDetail };
      }
      console.log(`[${name}] transient docker failure (exit ${result.exitCode}), retrying once...`);
    }
    console.log(`[${name}] FAIL —\n${lastDetail}`);
    return { name, passed: false, output: lastDetail };
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

console.log(`\n${"=".repeat(60)}`);
console.log("npm (Verdaccio) test");
console.log("=".repeat(60));

try {
  const npmPassed = await runNpmTest(version, tag);
  results.push({ name: "npm", status: npmPassed ? "pass" : "fail" });
} catch (e) {
  console.error(`[npm] Error:\n${describeError(e)}`);
  results.push({ name: "npm", status: "fail" });
}

// --- Summary ---

console.log(`\n${"=".repeat(60)}`);
console.log("Linux Smoke Test Summary");
console.log("=".repeat(60));

for (const r of results) {
  console.log(`  ${r.status === "pass" ? "PASS" : "FAIL"}  ${r.name}`);
}

const passed = results.filter((r) => r.status === "pass").length;
const failed = results.filter((r) => r.status === "fail").length;

console.log(`\n${passed} passed, ${failed} failed out of ${results.length} tests`);

if (failed > 0) {
  process.exit(1);
}
