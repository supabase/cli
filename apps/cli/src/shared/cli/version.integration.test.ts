import { describe, expect, test } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { CliOutput, Command } from "effect/unstable/cli";
import { fileURLToPath } from "node:url";
import { vi } from "vitest";
import { legacyRoot } from "../../legacy/cli/root.ts";
import { nextRoot } from "../../next/cli/root.ts";
import { textCliOutputFormatter } from "../output/text-formatter.ts";
import { CliArgs } from "./cli-args.service.ts";

describe("CLI --version (text)", () => {
  const versionLayer = (args: ReadonlyArray<string>) =>
    Layer.mergeAll(
      CliOutput.layer(textCliOutputFormatter()),
      Layer.succeed(CliArgs, { args }),
      BunServices.layer,
    );

  test("legacy shell prints bare semver on stdout", async () => {
    const logs: string[] = [];
    const spy = vi
      .spyOn(console, "log")
      .mockImplementation((first?: unknown, ...rest: unknown[]) => {
        const line =
          rest.length === 0
            ? first === undefined
              ? ""
              : String(first)
            : [first, ...rest].map(String).join(" ");
        logs.push(line);
      });
    try {
      // `Command.runWith` keeps handler/global-flag services in the effect type even when
      // `--version` exits early; only BunServices + CliOutput are needed at runtime here.
      await Effect.runPromise(
        Command.runWith(legacyRoot, { version: "2.99.0-beta.1" })(["--version"]).pipe(
          Effect.provide(versionLayer(["--version"])),
        ) as Effect.Effect<void>,
      );
    } finally {
      spy.mockRestore();
    }
    expect(logs.length).toBeGreaterThanOrEqual(1);
    expect(logs[0]).toMatch(/^\d+\.\d+\.\d+/);
    expect(logs[0]).not.toMatch(/supabase\s+v/i);
  });

  test("next shell prints bare semver on stdout", async () => {
    const logs: string[] = [];
    const spy = vi
      .spyOn(console, "log")
      .mockImplementation((first?: unknown, ...rest: unknown[]) => {
        const line =
          rest.length === 0
            ? first === undefined
              ? ""
              : String(first)
            : [first, ...rest].map(String).join(" ");
        logs.push(line);
      });
    try {
      await Effect.runPromise(
        Command.runWith(nextRoot, { version: "2.99.0-beta.1" })(["--version"]).pipe(
          Effect.provide(versionLayer(["--version"])),
        ) as Effect.Effect<void>,
      );
    } finally {
      spy.mockRestore();
    }
    expect(logs.length).toBeGreaterThanOrEqual(1);
    expect(logs[0]).toMatch(/^\d+\.\d+\.\d+/);
    expect(logs[0]).not.toMatch(/supabase\s+v/i);
  });

  test("source execution ignores a runtime version environment variable", async () => {
    const bunExecutable = Bun.which("bun");
    if (!bunExecutable) {
      throw new Error("Bun executable not found");
    }

    const versionModule = fileURLToPath(new URL("./version.ts", import.meta.url));
    const child = Bun.spawn(
      [
        bunExecutable,
        "-e",
        `import { CLI_VERSION } from ${JSON.stringify(versionModule)}; console.log(CLI_VERSION);`,
      ],
      {
        env: { ...process.env, SUPABASE_CLI_VERSION: "9.9.9" },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    expect(exitCode, stderr).toBe(0);
    expect(stdout.trim()).toBe("0.0.0-dev");
  });
});
