import { describe, expect, test } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { CliOutput, Command } from "effect/unstable/cli";
import { fileURLToPath } from "node:url";
import { vi } from "vitest";
import { rootCommand } from "../../cli/root.ts";
import { textCliOutputFormatter } from "../output/text-formatter.ts";
import { CliArgs } from "./cli-args.service.ts";
import { CLI_VERSION } from "./version.ts";

const formatLogArg = (value: unknown): string =>
  typeof value === "object" && value !== null ? JSON.stringify(value) : String(value);

const builtinLayer = (args: ReadonlyArray<string>) =>
  Layer.mergeAll(
    CliOutput.layer(textCliOutputFormatter()),
    Layer.succeed(CliArgs, { args }),
    BunServices.layer,
  );

/**
 * Captures `console.log` while `run` executes. Spying on `console.log` alone is reliable here;
 * `run.integration.test.ts` explains why pairing it with a `console.error` spy is not.
 */
async function captureLogs(run: () => Promise<void>): Promise<Array<string>> {
  const logs: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((first?: unknown, ...rest: unknown[]) => {
    const line =
      rest.length === 0
        ? first === undefined
          ? ""
          : formatLogArg(first)
        : [first, ...rest].map(formatLogArg).join(" ");
    logs.push(line);
  });
  try {
    await run();
  } finally {
    spy.mockRestore();
  }
  return logs;
}

describe("CLI --help (text)", () => {
  test("source runs describe themselves as a development build", async () => {
    // `Command.runWith` keeps handler/global-flag services in the effect type even when the
    // built-in `--help`/`--version` exits early; only BunServices + CliOutput are needed here.
    const logs = await captureLogs(() =>
      Effect.runPromise(
        Command.runWith(rootCommand, { version: CLI_VERSION })(["--help"]).pipe(
          Effect.provide(builtinLayer(["--help"])),
        ) as Effect.Effect<void>,
      ),
    );
    const help = logs.join("\n");
    expect(help).toContain("Supabase CLI (development build).");
    expect(help).not.toContain("stable channel");
  });
});

describe("CLI --version (text)", () => {
  test("CLI prints bare semver on stdout", async () => {
    const logs = await captureLogs(() =>
      Effect.runPromise(
        Command.runWith(rootCommand, { version: "2.99.0-beta.1" })(["--version"]).pipe(
          Effect.provide(builtinLayer(["--version"])),
        ) as Effect.Effect<void>,
      ),
    );
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
