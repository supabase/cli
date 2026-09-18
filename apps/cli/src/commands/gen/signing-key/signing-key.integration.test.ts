import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { Effect, Exit, Layer, Option, Sink, Stream } from "effect";
import { CliOutput, Command } from "effect/unstable/cli";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  mockAnalytics,
  mockOutput,
  mockRuntimeInfo,
  mockStdin,
  mockTty,
  processEnvLayer,
} from "../../../../tests/helpers/mocks.ts";
import {
  buildTestRuntime,
  mockCommandSettings,
  mockCommandPlatformApi,
  mockTelemetryStateTracked,
  useTempWorkdir,
} from "../../../../tests/helpers/command-mocks.ts";
import { CliArgs } from "../../../shared/cli/cli-args.service.ts";
import { DebugLogger } from "../../../command-internal/debug-logger.service.ts";
import { GLOBAL_FLAGS, YesFlag } from "../../../command-internal/global-flags.ts";
import { textCliOutputFormatter } from "../../../shared/output/text-formatter.ts";
import { processControlLayer } from "../../../shared/runtime/process-control.layer.ts";
import { TelemetryRuntime } from "../../../shared/telemetry/runtime.service.ts";
import { makeTelemetryIdentity } from "../../../shared/telemetry/identity.ts";
import { genCommand } from "../gen.command.ts";
import { genSigningKey } from "./signing-key.handler.ts";
import { DEFAULT_SIGNING_KEY } from "../../../command-internal/go-jwt.ts";

const tempRoot = useTempWorkdir("supabase-gen-signing-key-int-");

interface SetupOptions {
  readonly format?: "text" | "json" | "stream-json";
  readonly stdinIsTty?: boolean;
  readonly yes?: boolean;
  readonly promptConfirmResponses?: ReadonlyArray<boolean>;
  readonly trackTelemetry?: boolean;
  // Exit code for the mocked `git check-ignore` subprocess: `0` means ignored.
  readonly gitCheckIgnoreExitCode?: number;
  // Piped (non-TTY) stdin answer for the overwrite prompt.
  readonly pipedAnswer?: string;
  // Raw argv for `resolveYes`'s explicit `--yes=false` detection.
  readonly cliArgs?: ReadonlyArray<string>;
}

function mockGitCheckIgnore(exitCode: number) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() =>
      Effect.sync(() =>
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.empty,
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        }),
      ),
    ),
  );
}

function setup(options: SetupOptions = {}) {
  const out = mockOutput({
    format: options.format ?? "text",
    interactive: options.stdinIsTty ?? false,
    promptConfirmResponses: options.promptConfirmResponses,
  });
  const api = mockCommandPlatformApi();
  const cliSettings = mockCommandSettings({
    workdir: tempRoot.current,
    projectId: Option.none(),
  });
  const tty = mockTty({
    stdinIsTty: options.stdinIsTty ?? false,
    stdoutIsTty: options.stdinIsTty ?? false,
  });
  const telemetry = options.trackTelemetry ? mockTelemetryStateTracked() : undefined;
  const layer = Layer.mergeAll(
    buildTestRuntime({ out, api, cliSettings, tty, telemetry: telemetry?.layer }),
    Layer.succeed(YesFlag, options.yes ?? false),
    Layer.succeed(CliArgs, { args: options.cliArgs ?? [] }),
    mockStdin(options.stdinIsTty ?? false, options.pipedAnswer),
    Layer.succeed(DebugLogger, {
      debug: () => Effect.void,
      http: () => Effect.void,
    }),
    // Listed after buildTestRuntime so it overrides the real spawner from BunServices.
    mockGitCheckIgnore(options.gitCheckIgnoreExitCode ?? 1),
  );
  return { layer, out, telemetry };
}

async function writeConfig(contents: string) {
  await mkdir(join(tempRoot.current, "supabase"), { recursive: true });
  await writeFile(join(tempRoot.current, "supabase", "config.toml"), contents);
}

async function writeJsonConfig(contents: string) {
  await mkdir(join(tempRoot.current, "supabase"), { recursive: true });
  await writeFile(join(tempRoot.current, "supabase", "config.json"), contents);
}

// `findGitRoot` needs a real `.git` entry; `git check-ignore` itself is mocked separately.
async function initGitDir() {
  await mkdir(join(tempRoot.current, ".git"), { recursive: true });
}

const testRoot = Command.make("supabase").pipe(
  Command.withSubcommands([genCommand]),
  Command.withGlobalFlags(GLOBAL_FLAGS),
);

describe("gen signing-key integration", () => {
  it.live("prints a generated key to stdout when no signing_keys_path is configured", () => {
    const { layer, out } = setup();
    return Effect.gen(function* () {
      yield* genSigningKey({ algorithm: "ES256", append: false });

      const parsed = JSON.parse(out.stdoutText) as Record<string, unknown>;
      expect(parsed.alg).toBe("ES256");
      expect(parsed.kty).toBe("EC");
      expect(typeof parsed.kid).toBe("string");
      expect(out.stderrText).toContain("To enable JWT signing keys in your local project:");
      expect(out.stderrText).toContain(join("supabase", "signing_keys.json"));
      expect(out.stderrText.endsWith("\n\n")).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("prints a complete RS256 JWK to stdout when no signing_keys_path is configured", () => {
    const { layer, out } = setup();
    return Effect.gen(function* () {
      yield* genSigningKey({ algorithm: "RS256", append: false });

      const parsed = JSON.parse(out.stdoutText) as Record<string, unknown>;
      expect(parsed.kty).toBe("RSA");
      expect(parsed.alg).toBe("RS256");
      expect(parsed.use).toBe("sig");
      for (const field of ["n", "e", "d", "p", "q", "dp", "dq", "qi"]) {
        expect(typeof parsed[field]).toBe("string");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("runs through the command wiring without missing runtime services", () => {
    const out = mockOutput({ format: "text", interactive: false });
    const analytics = mockAnalytics();
    const layer = Layer.mergeAll(
      BunServices.layer,
      processControlLayer,
      CliOutput.layer(textCliOutputFormatter()),
      out.layer,
      analytics.layer,
      processEnvLayer({ SUPABASE_HOME: tempRoot.current }),
      mockRuntimeInfo({ cwd: tempRoot.current, homeDir: tempRoot.current }),
      mockTty({ stdinIsTty: false, stdoutIsTty: false }),
      Layer.succeed(CliArgs, { args: [] }),
      mockStdin(false),
      Layer.succeed(
        TelemetryRuntime,
        TelemetryRuntime.of({
          configDir: join(tempRoot.current, ".supabase"),
          tracesDir: join(tempRoot.current, ".supabase", "traces"),
          consent: "granted",
          showDebug: false,
          deviceId: "test-device-id",
          sessionId: "test-session-id",
          identity: makeTelemetryIdentity(undefined),
          isFirstRun: false,
          isTty: false,
          isCi: false,
          os: "linux",
          arch: "x64",
          cliVersion: "0.1.0",
        }),
      ),
    );

    return Effect.gen(function* () {
      yield* Command.runWith(testRoot, { version: "0.0.0-test" })([
        "gen",
        "signing-key",
        "--workdir",
        tempRoot.current,
      ]);

      const parsed = JSON.parse(out.stdoutText) as Record<string, unknown>;
      expect(parsed.alg).toBe("ES256");
      expect(out.stderrText).toContain("To enable JWT signing keys in your local project:");
    }).pipe(Effect.provide(layer)) as Effect.Effect<void>;
  });

  it.live(
    "ignores a stray config.json and uses the default config.toml path in the local setup hint (CLI-1961)",
    () => {
      const { layer, out } = setup();
      return Effect.gen(function* () {
        yield* Effect.tryPromise(() => writeJsonConfig("{}\n"));
        yield* genSigningKey({ algorithm: "ES256", append: false });

        expect(out.stderrText).toContain(join("supabase", "config.toml"));
        expect(out.stderrText).not.toContain("config.json");
        expect(out.stderrText).not.toContain(tempRoot.current);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "overwrites the configured signing keys file and defaults to yes on non-tty when stdin has no piped answer",
    () => {
      const { layer, out } = setup({ stdinIsTty: false });
      return Effect.gen(function* () {
        yield* Effect.tryPromise(() =>
          writeConfig('[auth]\nsigning_keys_path = "./signing_keys.json"\n'),
        );
        yield* Effect.tryPromise(() =>
          writeFile(join(tempRoot.current, "supabase", "signing_keys.json"), "[]\n"),
        );

        yield* genSigningKey({ algorithm: "RS256", append: false });

        const saved = yield* Effect.tryPromise(() =>
          readFile(join(tempRoot.current, "supabase", "signing_keys.json"), "utf8"),
        );
        const parsed = JSON.parse(saved) as ReadonlyArray<Record<string, unknown>>;
        expect(parsed).toHaveLength(1);
        expect(parsed[0]?.alg).toBe("RS256");
        expect(out.stderrText).toContain("Do you want to overwrite the existing");
        expect(out.stderrText).toContain("JWT signing key appended to: ");
        expect(out.stderrText).toContain(join("supabase", "signing_keys.json"));
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("cancels the overwrite when a piped non-tty answer of 'n' is read", () => {
    const { layer, out } = setup({ stdinIsTty: false, pipedAnswer: "n" });
    return Effect.gen(function* () {
      yield* Effect.tryPromise(() =>
        writeConfig('[auth]\nsigning_keys_path = "./signing_keys.json"\n'),
      );
      yield* Effect.tryPromise(() =>
        writeFile(join(tempRoot.current, "supabase", "signing_keys.json"), "[]\n"),
      );

      const exit = yield* Effect.exit(genSigningKey({ algorithm: "ES256", append: false }));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const json = JSON.stringify(exit.cause);
        expect(json).toContain("GenSigningKeyCancelledError");
        expect(json).toContain("context canceled");
      }

      const saved = yield* Effect.tryPromise(() =>
        readFile(join(tempRoot.current, "supabase", "signing_keys.json"), "utf8"),
      );
      expect(JSON.parse(saved)).toEqual([]);
      expect(out.stderrText).toContain("[Y/n] n\n");
    }).pipe(Effect.provide(layer));
  });

  it.live("overwrites when a piped non-tty answer of 'y' is read", () => {
    const { layer, out } = setup({ stdinIsTty: false, pipedAnswer: "y" });
    return Effect.gen(function* () {
      yield* Effect.tryPromise(() =>
        writeConfig('[auth]\nsigning_keys_path = "./signing_keys.json"\n'),
      );
      yield* Effect.tryPromise(() =>
        writeFile(join(tempRoot.current, "supabase", "signing_keys.json"), "[]\n"),
      );

      yield* genSigningKey({ algorithm: "ES256", append: false });

      const saved = yield* Effect.tryPromise(() =>
        readFile(join(tempRoot.current, "supabase", "signing_keys.json"), "utf8"),
      );
      const parsed = JSON.parse(saved) as ReadonlyArray<Record<string, unknown>>;
      expect(parsed).toHaveLength(1);
      expect(out.stderrText).toContain("Do you want to overwrite the existing");
    }).pipe(Effect.provide(layer));
  });

  it.live("passes an explicit default-yes prompt for interactive overwrite", () => {
    const { layer, out } = setup({ stdinIsTty: true });
    return Effect.gen(function* () {
      yield* Effect.tryPromise(() =>
        writeConfig('[auth]\nsigning_keys_path = "./signing_keys.json"\n'),
      );
      yield* Effect.tryPromise(() =>
        writeFile(join(tempRoot.current, "supabase", "signing_keys.json"), "[]\n"),
      );

      yield* genSigningKey({ algorithm: "ES256", append: false });

      expect(out.promptConfirmCalls).toHaveLength(1);
      expect(out.promptConfirmCalls[0]?.opts?.defaultValue).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("appends a new key when --append is set", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      yield* Effect.tryPromise(() =>
        writeConfig('[auth]\nsigning_keys_path = "./signing_keys.json"\n'),
      );
      yield* Effect.tryPromise(() =>
        writeFile(
          join(tempRoot.current, "supabase", "signing_keys.json"),
          `${JSON.stringify([
            {
              kty: "EC",
              x: "existing-x",
            },
          ])}\n`,
        ),
      );

      yield* genSigningKey({ algorithm: "ES256", append: true });

      const saved = yield* Effect.tryPromise(() =>
        readFile(join(tempRoot.current, "supabase", "signing_keys.json"), "utf8"),
      );
      const parsed = JSON.parse(saved) as ReadonlyArray<Record<string, unknown>>;
      expect(parsed).toHaveLength(2);
      expect(parsed[0]?.x).toBe("existing-x");
      expect(parsed[1]?.alg).toBe("ES256");
    }).pipe(Effect.provide(layer));
  });

  it.live("does not fail on a malformed signing keys file when [auth] enabled is false", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      yield* Effect.tryPromise(() =>
        writeConfig('[auth]\nenabled = false\nsigning_keys_path = "./signing_keys.json"\n'),
      );
      yield* Effect.tryPromise(() =>
        writeFile(join(tempRoot.current, "supabase", "signing_keys.json"), "not valid json {\n"),
      );

      const exit = yield* Effect.exit(genSigningKey({ algorithm: "ES256", append: true }));
      expect(Exit.isFailure(exit)).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "appends to (and overwrites with) the built-in default key, ignoring the real file content, when [auth] enabled is false",
    () => {
      const { layer } = setup();
      return Effect.gen(function* () {
        yield* Effect.tryPromise(() =>
          writeConfig('[auth]\nenabled = false\nsigning_keys_path = "./signing_keys.json"\n'),
        );
        yield* Effect.tryPromise(() =>
          writeFile(
            join(tempRoot.current, "supabase", "signing_keys.json"),
            `${JSON.stringify([{ kty: "EC", kid: "existing-key", x: "existing-x" }])}\n`,
          ),
        );

        yield* genSigningKey({ algorithm: "ES256", append: true });

        const saved = yield* Effect.tryPromise(() =>
          readFile(join(tempRoot.current, "supabase", "signing_keys.json"), "utf8"),
        );
        const parsed = JSON.parse(saved) as ReadonlyArray<Record<string, unknown>>;
        expect(parsed).toHaveLength(2);
        expect(parsed[0]?.kid).toBe(DEFAULT_SIGNING_KEY.kid);
        expect(parsed.some((key) => key["kid"] === "existing-key")).toBe(false);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("fails when the configured signing keys file is not a JSON array of objects", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      yield* Effect.tryPromise(() =>
        writeConfig('[auth]\nsigning_keys_path = "./signing_keys.json"\n'),
      );
      yield* Effect.tryPromise(() =>
        writeFile(join(tempRoot.current, "supabase", "signing_keys.json"), "[1]\n"),
      );

      const exit = yield* Effect.exit(genSigningKey({ algorithm: "ES256", append: false }));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const json = JSON.stringify(exit.cause);
        expect(json).toContain("GenSigningKeyDecodeError");
        expect(json).toContain("failed to decode signing keys");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with a config parse error when config.toml is malformed", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      yield* Effect.tryPromise(() => writeConfig("not valid toml ]["));

      const exit = yield* Effect.exit(genSigningKey({ algorithm: "ES256", append: false }));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("GenSigningKeyConfigParseError");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("fails when the configured signing keys file is not a JSON array at all", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      yield* Effect.tryPromise(() =>
        writeConfig('[auth]\nsigning_keys_path = "./signing_keys.json"\n'),
      );
      yield* Effect.tryPromise(() =>
        writeFile(join(tempRoot.current, "supabase", "signing_keys.json"), "{}\n"),
      );

      const exit = yield* Effect.exit(genSigningKey({ algorithm: "ES256", append: false }));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const json = JSON.stringify(exit.cause);
        expect(json).toContain("GenSigningKeyDecodeError");
        expect(json).toContain("expected a JSON array");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("resolves and displays an absolute signing_keys_path as configured", () => {
    const { layer, out } = setup();
    return Effect.gen(function* () {
      const absoluteKeysPath = join(tempRoot.current, "supabase", "absolute_keys.json");
      yield* Effect.tryPromise(() =>
        writeConfig(`[auth]\nsigning_keys_path = ${JSON.stringify(absoluteKeysPath)}\n`),
      );
      yield* Effect.tryPromise(() => writeFile(absoluteKeysPath, "[]\n"));

      yield* genSigningKey({ algorithm: "ES256", append: false });

      const saved = yield* Effect.tryPromise(() => readFile(absoluteKeysPath, "utf8"));
      const parsed = JSON.parse(saved) as ReadonlyArray<Record<string, unknown>>;
      expect(parsed).toHaveLength(1);
      expect(out.stderrText).toContain(absoluteKeysPath);
    }).pipe(Effect.provide(layer));
  });

  it.live("fails when signing_keys_path is configured but the file is missing", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      yield* Effect.tryPromise(() =>
        writeConfig('[auth]\nsigning_keys_path = "./signing_keys.json"\n'),
      );

      const exit = yield* Effect.exit(genSigningKey({ algorithm: "ES256", append: false }));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const json = JSON.stringify(exit.cause);
        expect(json).toContain("GenSigningKeyReadError");
        expect(json).toContain("failed to read signing keys");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("returns context canceled when a TTY user declines overwrite", () => {
    const { layer } = setup({ stdinIsTty: true, promptConfirmResponses: [false] });
    return Effect.gen(function* () {
      yield* Effect.tryPromise(() =>
        writeConfig('[auth]\nsigning_keys_path = "./signing_keys.json"\n'),
      );
      yield* Effect.tryPromise(() =>
        writeFile(join(tempRoot.current, "supabase", "signing_keys.json"), "[]\n"),
      );

      const exit = yield* Effect.exit(genSigningKey({ algorithm: "ES256", append: false }));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const json = JSON.stringify(exit.cause);
        expect(json).toContain("GenSigningKeyCancelledError");
        expect(json).toContain("context canceled");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("warns when the configured signing key path is not gitignored", () => {
    // git check-ignore exits non-zero when the path is NOT ignored.
    const { layer, out } = setup({ gitCheckIgnoreExitCode: 1 });
    return Effect.gen(function* () {
      yield* Effect.tryPromise(() =>
        writeConfig('[auth]\nsigning_keys_path = "./signing_keys.json"\n'),
      );
      yield* Effect.tryPromise(() => initGitDir());
      yield* Effect.tryPromise(() =>
        writeFile(join(tempRoot.current, "supabase", "signing_keys.json"), "[]\n"),
      );

      yield* genSigningKey({ algorithm: "ES256", append: false });

      expect(out.stderrText).toContain(
        "Add your signing key path to .gitignore to prevent committing to version control.",
      );
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "does not warn when gitignore rules already ignore the configured signing key path",
    () => {
      // git check-ignore exits zero when the path IS ignored.
      const { layer, out } = setup({ gitCheckIgnoreExitCode: 0 });
      return Effect.gen(function* () {
        yield* Effect.tryPromise(() =>
          writeConfig('[auth]\nsigning_keys_path = "./signing_keys.json"\n'),
        );
        yield* Effect.tryPromise(() => initGitDir());
        yield* Effect.tryPromise(() =>
          writeFile(join(tempRoot.current, "supabase", "signing_keys.json"), "[]\n"),
        );

        yield* genSigningKey({ algorithm: "ES256", append: false });

        expect(out.stderrText).not.toContain("IMPORTANT:");
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("echoes [Y/n] y to stderr when --yes bypasses overwrite confirmation", () => {
    const { layer, out } = setup({ yes: true, stdinIsTty: true });
    return Effect.gen(function* () {
      yield* Effect.tryPromise(() =>
        writeConfig('[auth]\nsigning_keys_path = "./signing_keys.json"\n'),
      );
      yield* Effect.tryPromise(() =>
        writeFile(join(tempRoot.current, "supabase", "signing_keys.json"), "[]\n"),
      );

      yield* genSigningKey({ algorithm: "ES256", append: false });

      expect(out.stderrText).toContain("[Y/n] y");
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "declines the overwrite without prompting on a tty when --output-format is not text",
    () => {
      const { layer, out } = setup({ format: "json", stdinIsTty: true });
      return Effect.gen(function* () {
        yield* Effect.tryPromise(() =>
          writeConfig('[auth]\nsigning_keys_path = "./signing_keys.json"\n'),
        );
        yield* Effect.tryPromise(() =>
          writeFile(join(tempRoot.current, "supabase", "signing_keys.json"), "[]\n"),
        );

        const exit = yield* Effect.exit(genSigningKey({ algorithm: "ES256", append: false }));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const json = JSON.stringify(exit.cause);
          expect(json).toContain("GenSigningKeyCancelledError");
        }

        const saved = yield* Effect.tryPromise(() =>
          readFile(join(tempRoot.current, "supabase", "signing_keys.json"), "utf8"),
        );
        expect(JSON.parse(saved)).toEqual([]);
        expect(out.promptConfirmCalls).toHaveLength(0);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("honors a piped non-tty 'n' even when --output-format is json", () => {
    const { layer, out } = setup({ format: "json", stdinIsTty: false, pipedAnswer: "n" });
    return Effect.gen(function* () {
      yield* Effect.tryPromise(() =>
        writeConfig('[auth]\nsigning_keys_path = "./signing_keys.json"\n'),
      );
      yield* Effect.tryPromise(() =>
        writeFile(join(tempRoot.current, "supabase", "signing_keys.json"), "[]\n"),
      );

      const exit = yield* Effect.exit(genSigningKey({ algorithm: "ES256", append: false }));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("GenSigningKeyCancelledError");
      }

      const saved = yield* Effect.tryPromise(() =>
        readFile(join(tempRoot.current, "supabase", "signing_keys.json"), "utf8"),
      );
      expect(JSON.parse(saved)).toEqual([]);
      expect(out.promptConfirmCalls).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.live("honors a piped non-tty 'y' when --output-format is stream-json", () => {
    const { layer } = setup({ format: "stream-json", stdinIsTty: false, pipedAnswer: "y" });
    return Effect.gen(function* () {
      yield* Effect.tryPromise(() =>
        writeConfig('[auth]\nsigning_keys_path = "./signing_keys.json"\n'),
      );
      yield* Effect.tryPromise(() =>
        writeFile(join(tempRoot.current, "supabase", "signing_keys.json"), "[]\n"),
      );

      yield* genSigningKey({ algorithm: "ES256", append: false });

      const saved = yield* Effect.tryPromise(() =>
        readFile(join(tempRoot.current, "supabase", "signing_keys.json"), "utf8"),
      );
      expect(JSON.parse(saved) as ReadonlyArray<unknown>).toHaveLength(1);
    }).pipe(Effect.provide(layer));
  });

  it.live("honors SUPABASE_YES and overwrites even when a piped 'n' is present", () => {
    const prev = process.env["SUPABASE_YES"];
    process.env["SUPABASE_YES"] = "1";
    const { layer } = setup({ stdinIsTty: false, pipedAnswer: "n" });
    return Effect.gen(function* () {
      yield* Effect.tryPromise(() =>
        writeConfig('[auth]\nsigning_keys_path = "./signing_keys.json"\n'),
      );
      yield* Effect.tryPromise(() =>
        writeFile(join(tempRoot.current, "supabase", "signing_keys.json"), "[]\n"),
      );

      yield* genSigningKey({ algorithm: "ES256", append: false });

      const saved = yield* Effect.tryPromise(() =>
        readFile(join(tempRoot.current, "supabase", "signing_keys.json"), "utf8"),
      );
      const parsed = JSON.parse(saved) as ReadonlyArray<Record<string, unknown>>;
      expect(parsed).toHaveLength(1);
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (prev === undefined) delete process.env["SUPABASE_YES"];
          else process.env["SUPABASE_YES"] = prev;
        }),
      ),
      Effect.provide(layer),
    );
  });

  it.live(
    "auto-confirms from SUPABASE_YES in the project .env, even with a piped 'n' (CLI-1878)",
    () => {
      // Clears any shell SUPABASE_YES so this proves the project-.env source specifically.
      const prev = process.env["SUPABASE_YES"];
      delete process.env["SUPABASE_YES"];
      const { layer } = setup({ stdinIsTty: false, pipedAnswer: "n" });
      return Effect.gen(function* () {
        yield* Effect.tryPromise(() =>
          writeConfig('[auth]\nsigning_keys_path = "./signing_keys.json"\n'),
        );
        yield* Effect.tryPromise(() =>
          writeFile(join(tempRoot.current, "supabase", "signing_keys.json"), "[]\n"),
        );
        yield* Effect.tryPromise(() =>
          writeFile(join(tempRoot.current, "supabase", ".env"), "SUPABASE_YES=true\n"),
        );

        yield* genSigningKey({ algorithm: "ES256", append: false });

        const saved = yield* Effect.tryPromise(() =>
          readFile(join(tempRoot.current, "supabase", "signing_keys.json"), "utf8"),
        );
        const parsed = JSON.parse(saved) as ReadonlyArray<Record<string, unknown>>;
        expect(parsed).toHaveLength(1);
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (prev !== undefined) process.env["SUPABASE_YES"] = prev;
          }),
        ),
        Effect.provide(layer),
      );
    },
  );

  it.live("an explicit --yes=false overrides SUPABASE_YES and honors a piped 'n'", () => {
    const prev = process.env["SUPABASE_YES"];
    process.env["SUPABASE_YES"] = "1";
    const { layer } = setup({
      stdinIsTty: false,
      pipedAnswer: "n",
      cliArgs: ["gen", "signing-key", "--yes=false"],
    });
    return Effect.gen(function* () {
      yield* Effect.tryPromise(() =>
        writeConfig('[auth]\nsigning_keys_path = "./signing_keys.json"\n'),
      );
      yield* Effect.tryPromise(() =>
        writeFile(join(tempRoot.current, "supabase", "signing_keys.json"), "[]\n"),
      );

      const exit = yield* Effect.exit(genSigningKey({ algorithm: "ES256", append: false }));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("GenSigningKeyCancelledError");
      }

      const saved = yield* Effect.tryPromise(() =>
        readFile(join(tempRoot.current, "supabase", "signing_keys.json"), "utf8"),
      );
      expect(JSON.parse(saved)).toEqual([]);
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (prev === undefined) delete process.env["SUPABASE_YES"];
          else process.env["SUPABASE_YES"] = prev;
        }),
      ),
      Effect.provide(layer),
    );
  });

  it.live("flushes telemetry state after the command finishes", () => {
    const { layer, telemetry } = setup({ trackTelemetry: true });
    return Effect.gen(function* () {
      yield* genSigningKey({ algorithm: "ES256", append: false });
      expect(telemetry?.flushed).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("flushes telemetry state even when the project .env is malformed (Codex review)", () => {
    const { layer, telemetry } = setup({ trackTelemetry: true });
    return Effect.gen(function* () {
      yield* Effect.tryPromise(() =>
        mkdir(join(tempRoot.current, "supabase"), { recursive: true }),
      );
      yield* Effect.tryPromise(() =>
        writeFile(join(tempRoot.current, "supabase", ".env"), "!=broken\n"),
      );

      const exit = yield* Effect.exit(genSigningKey({ algorithm: "ES256", append: false }));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("DbConfigLoadError");
      }
      expect(telemetry?.flushed).toBe(true);
    }).pipe(Effect.provide(layer));
  });
});
