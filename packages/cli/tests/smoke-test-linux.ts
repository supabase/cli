import { $ } from "bun";
import path from "node:path";
import { parseArgs } from "node:util";
import { runNpmTest } from "./helpers/npm-registry.ts";

const { values } = parseArgs({
  options: {
    version: { type: "string", default: "0.0.1-smoke" },
  },
});

const version = values.version!;
const root = path.resolve(import.meta.dir, "../../..");
const distDir = path.join(root, "dist");

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
    const passed = /^\d+\.\d+\.\d+/.test(trimmed);
    console.log(`[${name}] ${passed ? "PASS" : "FAIL"} — ${trimmed}`);
    results.push({ name, status: passed ? "pass" : "fail" });
  } catch (e) {
    console.log(`[${name}] FAIL — ${e}`);
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

  async function runDockerTest(
    name: string,
    image: string,
    platform: string,
    commands: string,
  ): Promise<DockerResult> {
    console.log(`[${name}] Running...`);
    try {
      const output =
        await $`docker run --rm --platform ${platform} -v ${distDir}:/dist:ro ${image} sh -c ${commands}`.text();
      const trimmed = output.trim();
      const lastLine = trimmed.split("\n").pop()!;
      const passed = /^\d+\.\d+\.\d+/.test(lastLine);
      console.log(`[${name}] ${passed ? "PASS" : "FAIL"} — ${lastLine}`);
      return { name, passed, output: trimmed };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.log(`[${name}] FAIL — ${msg}`);
      return { name, passed: false, output: msg };
    }
  }

  const jobs: Promise<DockerResult>[] = [];

  for (const arch of ["arm64", "amd64"] as const) {
    const dockerPlatform = `linux/${arch}`;

    jobs.push(
      runDockerTest(
        `linux-${arch}-tarball`,
        "debian:bookworm-slim",
        dockerPlatform,
        `tar -xzf /dist/supabase_${version}_linux_${arch}.tar.gz -C /usr/local/bin && supabase --version`,
      ),
    );

    jobs.push(
      runDockerTest(
        `linux-${arch}-deb`,
        "debian:bookworm-slim",
        dockerPlatform,
        `dpkg -i /dist/supabase_${version}_linux_${arch}.deb && supabase --version`,
      ),
    );

    jobs.push(
      runDockerTest(
        `linux-${arch}-rpm`,
        "amazonlinux:2023",
        dockerPlatform,
        `rpm -ivh /dist/supabase_${version}_linux_${arch}.rpm && supabase --version`,
      ),
    );

    jobs.push(
      runDockerTest(
        `linux-${arch}-apk`,
        "alpine:3.21",
        dockerPlatform,
        `apk add --allow-untrusted /dist/supabase_${version}_linux_${arch}.apk && supabase --version`,
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
  const npmPassed = await runNpmTest(version);
  results.push({ name: "npm", status: npmPassed ? "pass" : "fail" });
} catch (e) {
  console.error(`[npm] Error: ${e}`);
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
