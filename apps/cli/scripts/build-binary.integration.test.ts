import { afterEach, describe, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { NATIVE_PROCESS_DISPATCH_SENTINEL } from "@supabase/stack/internal/supervisor";

const fixturePath = fileURLToPath(
  new URL("../tests/fixtures/compiled-libpg-query.ts", import.meta.url),
);
const versionFixturePath = fileURLToPath(
  new URL("../tests/fixtures/compiled-cli-version.ts", import.meta.url),
);
const nativeDispatchFixturePath = fileURLToPath(
  new URL("../tests/fixtures/compiled-native-dispatch.ts", import.meta.url),
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

  test("embeds the build version independently of the runtime environment", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "supabase-compiled-version-"));
    temporaryDirectories.push(directory);
    const executable = path.join(directory, "version-probe");
    const bunExecutable = Bun.which("bun");
    if (!bunExecutable) {
      throw new Error("Bun executable not found");
    }

    const build = Bun.spawn(
      [
        bunExecutable,
        "build",
        versionFixturePath,
        "--compile",
        `--define=SUPABASE_CLI_VERSION=${JSON.stringify("7.8.9-beta.1")}`,
        `--outfile=${executable}`,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [buildExitCode, buildStderr] = await Promise.all([
      build.exited,
      new Response(build.stderr).text(),
    ]);
    expect(buildExitCode, buildStderr).toBe(0);

    const probe = Bun.spawn([executable], {
      cwd: directory,
      env: { SUPABASE_CLI_VERSION: "9.9.9" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [probeExitCode, stdout, stderr] = await Promise.all([
      probe.exited,
      new Response(probe.stdout).text(),
      new Response(probe.stderr).text(),
    ]);

    expect(probeExitCode, stderr).toBe(0);
    expect(stdout.trim()).toBe("7.8.9-beta.1");
  }, 20_000);

  test("dispatches the embedded native launcher from a compiled binary", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "supabase-compiled-native-"));
    temporaryDirectories.push(directory);
    const executable = path.join(directory, "native-dispatch-probe");
    const reap = async (child: ReturnType<typeof spawn> | undefined): Promise<void> => {
      if (child === undefined || child.exitCode !== null || child.signalCode !== null) return;
      await new Promise<void>((resolve) => {
        const done = () => {
          child.off("exit", done);
          child.off("error", done);
          resolve();
        };
        child.once("exit", done);
        child.once("error", done);
        child.kill("SIGKILL");
      });
    };

    let build: ReturnType<typeof spawn> | undefined;
    let child: ReturnType<typeof spawn> | undefined;
    let buildStderr: Promise<string> | undefined;
    let stdout: Promise<string> | undefined;
    let stderr: Promise<string> | undefined;
    try {
      build = spawn(
        "bun",
        ["build", nativeDispatchFixturePath, "--compile", `--outfile=${executable}`],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      buildStderr = new Response(build.stderr!).text();
      const [buildExitCode] = (await once(build, "exit")) as [number | null, NodeJS.Signals | null];
      expect(buildExitCode, await buildStderr).toBe(0);

      child = spawn(executable, [NATIVE_PROCESS_DISPATCH_SENTINEL], {
        cwd: directory,
        env: {},
        stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"],
      });
      stdout = new Response(child.stdout!).text();
      stderr = new Response(child.stderr!).text();
      const payload = JSON.stringify({
        executable: process.execPath,
        args: ["-e", "process.stdout.write('native launcher dispatch ok\\n')"],
      });
      const payloadFd = child.stdio[4];
      if (
        payloadFd == null ||
        typeof payloadFd === "number" ||
        !("end" in payloadFd) ||
        typeof payloadFd.end !== "function"
      ) {
        throw new Error("compiled native dispatch probe did not expose payload fd");
      }
      payloadFd.end(payload);
      const [exitCode] = (await once(child, "exit")) as [number | null, NodeJS.Signals | null];

      expect(exitCode, await stderr).toBe(0);
      expect((await stdout).trim()).toBe("native launcher dispatch ok");
    } finally {
      await reap(child);
      await reap(build);
      await Promise.all([
        buildStderr?.catch(() => ""),
        stdout?.catch(() => ""),
        stderr?.catch(() => ""),
      ]);
    }
  }, 30_000);
});
