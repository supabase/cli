import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { fileURLToPath } from "node:url";

import { AGENT_DETECTION_ENV_KEYS } from "../../../tests/helpers/cli.ts";

const FIXTURE = fileURLToPath(
  new URL("../../../tests/fixtures/standard-errors-cli.ts", import.meta.url),
);

/**
 * `runCli` ends with `process.exit`, so the exit code and the stderr ordering are only observable
 * from a subprocess running the fixture CLI through the real run path.
 */
const runFixture = Effect.fn("StandardErrorsTest.run")(function* (
  args: ReadonlyArray<string>,
  env: Record<string, string> = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const home = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-standard-errors-" });
  const bun = yield* Effect.fromNullishOr(Bun.which("bun"));
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(
    ChildProcess.make(bun, [FIXTURE, ...args], {
      env: {
        ...Object.fromEntries(AGENT_DETECTION_ENV_KEYS.map((key) => [key, ""])),
        SUPABASE_HOME: home,
        SUPABASE_NO_KEYRING: "1",
        SUPABASE_TELEMETRY_DISABLED: "1",
        SUPABASE_NO_UPDATE_NOTIFIER: "1",
        ...env,
      },
      extendEnv: true,
      stdin: "ignore",
    }),
  );
  const [exitCode, stdout, stderr] = yield* Effect.all(
    [
      child.exitCode,
      Stream.mkString(Stream.decodeText(child.stdout)),
      Stream.mkString(Stream.decodeText(child.stderr)),
    ],
    { concurrency: "unbounded" },
  );
  return { exitCode: Number(exitCode), stdout, stderr };
}, Effect.scoped);

const lastLine = (text: string) => text.trimEnd().split("\n").at(-1) ?? "";
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

describe("errors.standard failure contract", () => {
  it.live("reports an API conflict as the last stderr line and nothing on stdout", () =>
    Effect.gen(function* () {
      const { exitCode, stdout, stderr } = yield* runFixture(["conflict", "-o", "json"]);
      expect(stdout).toBe("");
      expect(exitCode).toBe(1);
      expect(stderr.endsWith("\n")).toBe(true);
      expect(yield* decodeJson(lastLine(stderr))).toEqual({
        code: "conflict",
        status: 409,
        message: "Resource already exists",
        hint: "Pick another name",
        api_code: "already_exists",
      });
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live(
    "a run that cannot ask for consent is a usage error telling the caller to pass --yes",
    () =>
      Effect.gen(function* () {
        const { exitCode, stdout, stderr } = yield* runFixture(["needs-consent"]);
        expect(stdout).toBe("");
        expect(exitCode).toBe(2);
        expect(yield* decodeJson(lastLine(stderr))).toMatchObject({
          code: "usage_error",
          hint: "Pass --yes",
        });
      }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("conflicting target selectors are a usage error that keeps the suggestion", () =>
    Effect.gen(function* () {
      const { exitCode, stdout, stderr } = yield* runFixture([
        "select",
        "--remote=abcdefghijklmnopqrst",
        "--project-ref",
        "tsrqponmlkjihgfedcba",
      ]);
      expect(stdout).toBe("");
      expect(exitCode).toBe(2);
      expect(yield* decodeJson(lastLine(stderr))).toMatchObject({
        code: "usage_error",
        message: expect.stringContaining("--project-ref cannot be combined with --remote"),
        hint: expect.stringContaining("--remote"),
      });
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("a declined confirmation exits 130 as cancelled", () =>
    Effect.gen(function* () {
      const { exitCode, stderr } = yield* runFixture(["declined"]);
      expect(exitCode).toBe(130);
      expect(yield* decodeJson(lastLine(stderr))).toMatchObject({ code: "cancelled" });
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("an unknown flag is a usage error after the help text", () =>
    Effect.gen(function* () {
      const { exitCode, stdout, stderr } = yield* runFixture(["conflict", "--nope"]);
      expect(stdout).toBe("");
      expect(exitCode).toBe(2);
      expect(stderr).toContain("USAGE");
      expect(yield* decodeJson(lastLine(stderr))).toMatchObject({
        code: "usage_error",
        message: expect.stringContaining("--nope"),
      });
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("a defect is an internal error", () =>
    Effect.gen(function* () {
      const { exitCode, stderr } = yield* runFixture(["crash"]);
      expect(exitCode).toBe(1);
      expect(yield* decodeJson(lastLine(stderr))).toMatchObject({ code: "internal_error" });
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("an agent run on a terminal still reports the JSON document", () =>
    Effect.gen(function* () {
      const { exitCode, stdout, stderr } = yield* runFixture(["conflict", "--agent=yes"], {
        STANDARD_ERRORS_FIXTURE_TTY: "1",
      });
      expect(stdout).toBe("");
      expect(exitCode).toBe(1);
      expect(yield* decodeJson(lastLine(stderr))).toMatchObject({ code: "conflict", status: 409 });
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("a terminal run prints the message and hint as text with the same exit code", () =>
    Effect.gen(function* () {
      const { exitCode, stdout, stderr } = yield* runFixture(["conflict"], {
        STANDARD_ERRORS_FIXTURE_TTY: "1",
      });
      expect(stdout).toBe("");
      expect(exitCode).toBe(1);
      expect(stderr).toContain("Resource already exists");
      expect(lastLine(stderr)).toBe("Pick another name");
      expect(stderr).not.toContain('"code"');
    }).pipe(Effect.provide(BunServices.layer)),
  );
});

describe("commands without the standard marker", () => {
  it.live("keep the legacy JSON envelope on stdout and exit 1", () =>
    Effect.gen(function* () {
      const { exitCode, stdout, stderr } = yield* runFixture(["legacy", "--output-format", "json"]);
      expect(exitCode).toBe(1);
      expect(stdout).toBe(
        '{"_tag":"Error","error":{"code":"LegacyBoomError","message":"legacy boom"}}\n',
      );
      expect(stderr).toBe("");
    }).pipe(Effect.provide(BunServices.layer)),
  );
});
