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
  mockTty,
  processEnvLayer,
} from "../../../../../tests/helpers/mocks.ts";
import {
  buildLegacyTestRuntime,
  mockLegacyCliConfig,
  mockLegacyPlatformApi,
  mockLegacyTelemetryStateTracked,
  useLegacyTempWorkdir,
} from "../../../../../tests/helpers/legacy-mocks.ts";
import { LegacyDebugLogger } from "../../../shared/legacy-debug-logger.service.ts";
import { LEGACY_GLOBAL_FLAGS, LegacyYesFlag } from "../../../../shared/legacy/global-flags.ts";
import { textCliOutputFormatter } from "../../../../shared/output/text-formatter.ts";
import { processControlLayer } from "../../../../shared/runtime/process-control.layer.ts";
import { TelemetryRuntime } from "../../../../shared/telemetry/runtime.service.ts";
import { legacyGenCommand } from "../gen.command.ts";
import { legacyGenSigningKey } from "./signing-key.handler.ts";

const tempRoot = useLegacyTempWorkdir("supabase-gen-signing-key-int-");

interface SetupOptions {
  readonly stdinIsTty?: boolean;
  readonly yes?: boolean;
  readonly promptConfirmResponses?: ReadonlyArray<boolean>;
  readonly trackTelemetry?: boolean;
  // Exit code returned by the mocked `git check-ignore` subprocess. `0` means the path is
  // ignored, any non-zero code means it is not. Only consumed by the gitignore-warning branch.
  readonly gitCheckIgnoreExitCode?: number;
}

// `git check-ignore` is invoked via ChildProcessSpawner. Mock it with a controlled exit code so
// the gitignore-warning branch is exercised in-process without depending on a real `git` binary.
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
    format: "text",
    interactive: options.stdinIsTty ?? false,
    promptConfirmResponses: options.promptConfirmResponses,
  });
  const api = mockLegacyPlatformApi();
  const cliConfig = mockLegacyCliConfig({ workdir: tempRoot.current, projectId: Option.none() });
  const tty = mockTty({
    stdinIsTty: options.stdinIsTty ?? false,
    stdoutIsTty: options.stdinIsTty ?? false,
  });
  const telemetry = options.trackTelemetry ? mockLegacyTelemetryStateTracked() : undefined;
  const layer = Layer.mergeAll(
    buildLegacyTestRuntime({ out, api, cliConfig, tty, telemetry: telemetry?.layer }),
    Layer.succeed(LegacyYesFlag, options.yes ?? false),
    Layer.succeed(LegacyDebugLogger, {
      debug: () => Effect.void,
      http: () => Effect.void,
    }),
    // Listed after buildLegacyTestRuntime so it overrides the real spawner from BunServices.
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

// `findGitRoot` walks up looking for a real `.git` entry, so the gitignore branch needs one to
// exist; the `git check-ignore` call itself is mocked via `gitCheckIgnoreExitCode`.
async function initGitDir() {
  await mkdir(join(tempRoot.current, ".git"), { recursive: true });
}

const legacyTestRoot = Command.make("supabase").pipe(
  Command.withGlobalFlags(LEGACY_GLOBAL_FLAGS),
  Command.withSubcommands([legacyGenCommand]),
);

describe("legacy gen signing-key integration", () => {
  it.live("prints a generated key to stdout when no signing_keys_path is configured", () => {
    const { layer, out } = setup();
    return Effect.gen(function* () {
      yield* legacyGenSigningKey({ algorithm: "ES256", append: false });

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
      yield* legacyGenSigningKey({ algorithm: "RS256", append: false });

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
      Layer.succeed(
        TelemetryRuntime,
        TelemetryRuntime.of({
          configDir: join(tempRoot.current, ".supabase"),
          tracesDir: join(tempRoot.current, ".supabase", "traces"),
          consent: "granted",
          showDebug: false,
          deviceId: "test-device-id",
          sessionId: "test-session-id",
          distinctId: undefined,
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
      yield* Command.runWith(legacyTestRoot, { version: "0.0.0-test" })([
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

  it.live("uses the project-relative config file path in the local setup hint", () => {
    const { layer, out } = setup();
    return Effect.gen(function* () {
      yield* Effect.tryPromise(() => writeJsonConfig("{}\n"));
      yield* legacyGenSigningKey({ algorithm: "ES256", append: false });

      // Go prints the CWD-relative `supabase/config.toml`; the hint must stay relative and must
      // never leak the absolute temp-dir path.
      expect(out.stderrText).toContain(join("supabase", "config.json"));
      expect(out.stderrText).not.toContain(join(tempRoot.current, "supabase", "config.json"));
    }).pipe(Effect.provide(layer));
  });

  it.live("overwrites the configured signing keys file and defaults to yes on non-tty", () => {
    const { layer, out } = setup({ stdinIsTty: false });
    return Effect.gen(function* () {
      yield* Effect.tryPromise(() =>
        writeConfig('[auth]\nsigning_keys_path = "./signing_keys.json"\n'),
      );
      yield* Effect.tryPromise(() =>
        writeFile(join(tempRoot.current, "supabase", "signing_keys.json"), "[]\n"),
      );

      yield* legacyGenSigningKey({ algorithm: "RS256", append: false });

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

      yield* legacyGenSigningKey({ algorithm: "ES256", append: false });

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

      yield* legacyGenSigningKey({ algorithm: "ES256", append: true });

      const saved = yield* Effect.tryPromise(() =>
        readFile(join(tempRoot.current, "supabase", "signing_keys.json"), "utf8"),
      );
      const parsed = JSON.parse(saved) as ReadonlyArray<Record<string, unknown>>;
      expect(parsed).toHaveLength(2);
      expect(parsed[0]?.x).toBe("existing-x");
      expect(parsed[1]?.alg).toBe("ES256");
    }).pipe(Effect.provide(layer));
  });

  it.live("fails when the configured signing keys file is not a JSON array of objects", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      yield* Effect.tryPromise(() =>
        writeConfig('[auth]\nsigning_keys_path = "./signing_keys.json"\n'),
      );
      yield* Effect.tryPromise(() =>
        writeFile(join(tempRoot.current, "supabase", "signing_keys.json"), "[1]\n"),
      );

      const exit = yield* Effect.exit(legacyGenSigningKey({ algorithm: "ES256", append: false }));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const json = JSON.stringify(exit.cause);
        expect(json).toContain("LegacyGenSigningKeyDecodeError");
        expect(json).toContain("failed to decode signing keys");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with a config parse error when config.toml is malformed", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      yield* Effect.tryPromise(() => writeConfig("not valid toml ]["));

      const exit = yield* Effect.exit(legacyGenSigningKey({ algorithm: "ES256", append: false }));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("LegacyGenSigningKeyConfigParseError");
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

      const exit = yield* Effect.exit(legacyGenSigningKey({ algorithm: "ES256", append: false }));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const json = JSON.stringify(exit.cause);
        expect(json).toContain("LegacyGenSigningKeyDecodeError");
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

      yield* legacyGenSigningKey({ algorithm: "ES256", append: false });

      const saved = yield* Effect.tryPromise(() => readFile(absoluteKeysPath, "utf8"));
      const parsed = JSON.parse(saved) as ReadonlyArray<Record<string, unknown>>;
      expect(parsed).toHaveLength(1);
      // An absolute configured path is displayed verbatim, matching Go.
      expect(out.stderrText).toContain(absoluteKeysPath);
    }).pipe(Effect.provide(layer));
  });

  it.live("fails when signing_keys_path is configured but the file is missing", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      yield* Effect.tryPromise(() =>
        writeConfig('[auth]\nsigning_keys_path = "./signing_keys.json"\n'),
      );

      const exit = yield* Effect.exit(legacyGenSigningKey({ algorithm: "ES256", append: false }));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const json = JSON.stringify(exit.cause);
        expect(json).toContain("LegacyGenSigningKeyReadError");
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

      const exit = yield* Effect.exit(legacyGenSigningKey({ algorithm: "ES256", append: false }));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const json = JSON.stringify(exit.cause);
        expect(json).toContain("LegacyGenSigningKeyCancelledError");
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

      yield* legacyGenSigningKey({ algorithm: "ES256", append: false });

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

        yield* legacyGenSigningKey({ algorithm: "ES256", append: false });

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

      yield* legacyGenSigningKey({ algorithm: "ES256", append: false });

      expect(out.stderrText).toContain("[Y/n] y");
    }).pipe(Effect.provide(layer));
  });

  it.live("flushes telemetry state after the command finishes", () => {
    const { layer, telemetry } = setup({ trackTelemetry: true });
    return Effect.gen(function* () {
      yield* legacyGenSigningKey({ algorithm: "ES256", append: false });
      expect(telemetry?.flushed).toBe(true);
    }).pipe(Effect.provide(layer));
  });
});
