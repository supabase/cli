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

  // Pull images serially before the parallel fan-out below. Eight concurrent
  // `docker run` calls otherwise race on first-time image pulls (especially for
  // arm64 variants going through QEMU), which surfaces as docker exit 125
  // ("daemon could not start the container") on a subset of jobs.
  const images: ReadonlyArray<{ image: string; platform: string }> = [
    { image: "debian:bookworm-slim", platform: "linux/amd64" },
    { image: "debian:bookworm-slim", platform: "linux/arm64" },
    { image: "amazonlinux:2023", platform: "linux/amd64" },
    { image: "amazonlinux:2023", platform: "linux/arm64" },
    { image: "alpine:3.21", platform: "linux/amd64" },
    { image: "alpine:3.21", platform: "linux/arm64" },
  ];
  for (const { image, platform } of images) {
    console.log(`[pull] ${platform} ${image}`);
    let lastErr: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const result = await $`docker pull --platform ${platform} ${image}`.nothrow().quiet();
      if (result.exitCode === 0) {
        lastErr = undefined;
        break;
      }
      lastErr = result.stderr.toString().trim() || `exit ${result.exitCode}`;
      console.log(`[pull] attempt ${attempt} failed: ${lastErr}`);
    }
    if (lastErr !== undefined) {
      console.error(`[pull] FAIL — ${platform} ${image}: ${lastErr}`);
      process.exit(1);
    }
  }

  async function runDockerTest(
    name: string,
    image: string,
    platform: string,
    commands: string,
  ): Promise<DockerResult> {
    console.log(`[${name}] Running...`);
    for (let attempt = 1; attempt <= 2; attempt++) {
      const result =
        await $`docker run --rm --platform ${platform} -v ${distDir}:/dist:ro ${image} sh -c ${commands}`
          .nothrow()
          .quiet();
      const stdout = result.stdout.toString().trim();
      const stderr = result.stderr.toString().trim();
      if (result.exitCode === 0) {
        const lastLine = stdout.split("\n").pop() ?? "";
        const passed = /^\d+\.\d+\.\d+/.test(lastLine);
        console.log(`[${name}] ${passed ? "PASS" : "FAIL"} — ${lastLine}`);
        if (!passed && stderr) console.log(`[${name}] stderr: ${stderr}`);
        return { name, passed, output: stdout };
      }
      // Exit 125 is a docker daemon / container-start error, not a container
      // exit code. Retry once before giving up.
      if (result.exitCode === 125 && attempt === 1) {
        console.log(`[${name}] docker exit 125, retrying once. stderr: ${stderr}`);
        continue;
      }
      console.log(`[${name}] FAIL — exit ${result.exitCode}`);
      if (stderr) console.log(`[${name}] stderr: ${stderr}`);
      if (stdout) console.log(`[${name}] stdout: ${stdout}`);
      return { name, passed: false, output: `${stdout}\n${stderr}`.trim() };
    }
    return { name, passed: false, output: "unreachable" };
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
