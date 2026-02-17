import { $ } from "bun";
import path from "node:path";
import { parseArgs } from "node:util";

try {
  await $`docker --version`.quiet();
} catch {
  console.log("[docker] SKIP — docker not found");
  process.exit(0);
}

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
  passed: boolean;
  output: string;
}

async function runDockerTest(
  name: string,
  image: string,
  platform: string,
  commands: string,
): Promise<TestResult> {
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

const jobs: Promise<TestResult>[] = [];

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

const results = await Promise.all(jobs);

// --- Summary ---

console.log("\n=== Summary ===");
const passed = results.filter((r) => r.passed);
const failed = results.filter((r) => !r.passed);

for (const r of results) {
  console.log(`  ${r.passed ? "PASS" : "FAIL"}  ${r.name}`);
}

console.log(`\n${passed.length} passed, ${failed.length} failed out of ${results.length} tests`);

if (failed.length > 0) {
  process.exit(1);
}
