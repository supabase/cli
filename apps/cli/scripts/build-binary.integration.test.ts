import { afterEach, describe, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const fixturePath = fileURLToPath(
  new URL("../tests/fixtures/compiled-libpg-query.ts", import.meta.url),
);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("compiled binary assets", () => {
  test("embeds and loads libpg-query.wasm", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "supabase-compiled-wasm-"));
    temporaryDirectories.push(directory);
    const executable = path.join(directory, "parser-probe");
    const bunExecutable = Bun.which("bun");
    if (!bunExecutable) {
      throw new Error("Bun executable not found");
    }

    const build = Bun.spawn(
      [bunExecutable, "build", fixturePath, "--compile", `--outfile=${executable}`],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [buildExitCode, buildStderr] = await Promise.all([
      build.exited,
      new Response(build.stderr).text(),
    ]);
    expect(buildExitCode, buildStderr).toBe(0);

    const probe = Bun.spawn([executable], {
      cwd: directory,
      env: {},
      stdout: "pipe",
      stderr: "pipe",
    });
    const [probeExitCode, stdout, stderr] = await Promise.all([
      probe.exited,
      new Response(probe.stdout).text(),
      new Response(probe.stderr).text(),
    ]);

    expect(probeExitCode, stderr).toBe(0);
    expect(stdout).toContain("libpg-query.wasm loaded");
  }, 20_000);
});
