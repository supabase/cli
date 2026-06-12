import { describe, expect, test } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { CliOutput, Command } from "effect/unstable/cli";
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
      // `Command.runWith` keeps handler/global-flag services in its env type even when
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
});
