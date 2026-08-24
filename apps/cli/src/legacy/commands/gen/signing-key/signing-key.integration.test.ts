import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import {
  ConfigProvider,
  Effect,
  Exit,
  FileSystem,
  Layer,
  ManagedRuntime,
  Option,
  Path,
  Schema,
  Sink,
  Stream,
} from "effect";
import * as Formatter from "effect/Formatter";
import { ChildProcessSpawner } from "effect/unstable/process";

import { mockOutput, mockStdin, mockTty } from "../../../../../tests/helpers/mocks.ts";
import {
  buildLegacyTestRuntime,
  mockLegacyCliConfig,
  mockLegacyPlatformApi,
  mockLegacyTelemetryStateTracked,
  useLegacyTempWorkdir,
} from "../../../../../tests/helpers/legacy-mocks.ts";
import { CliArgs } from "../../../../shared/cli/cli-args.service.ts";
import { LegacyDebugLogger } from "../../../shared/legacy-debug-logger.service.ts";
import { LegacyYesFlag } from "../../../../shared/legacy/global-flags.ts";
import { legacyGenSigningKey } from "./signing-key.handler.ts";
import { LEGACY_DEFAULT_SIGNING_KEY } from "../../../shared/legacy-go-jwt.ts";

const tempRoot = useLegacyTempWorkdir("supabase-gen-signing-key-int-");
const fixturePath = ManagedRuntime.make(BunServices.layer).runSync(Path.Path);
const join = (first: string, ...rest: ReadonlyArray<string>) => fixturePath.join(first, ...rest);

const SigningKeySchema = Schema.Struct({
  alg: Schema.optional(Schema.String),
  kty: Schema.String,
  use: Schema.optional(Schema.String),
  kid: Schema.optional(Schema.String),
  crv: Schema.optional(Schema.String),
  x: Schema.optional(Schema.String),
  y: Schema.optional(Schema.String),
  d: Schema.optional(Schema.String),
  n: Schema.optional(Schema.String),
  e: Schema.optional(Schema.String),
  p: Schema.optional(Schema.String),
  q: Schema.optional(Schema.String),
  dp: Schema.optional(Schema.String),
  dq: Schema.optional(Schema.String),
  qi: Schema.optional(Schema.String),
});
const SigningKeyCodec = Schema.fromJsonString(SigningKeySchema);
const SigningKeysCodec = Schema.fromJsonString(Schema.Array(SigningKeySchema));
const decodeSigningKey = Schema.decodeSync(SigningKeyCodec);
const decodeSigningKeys = Schema.decodeSync(SigningKeysCodec);
const encodeSigningKeys = Schema.encodeSync(SigningKeysCodec);

interface SetupOptions {
  readonly format?: "text" | "json" | "stream-json";
  readonly stdinIsTty?: boolean;
  readonly yes?: boolean;
  readonly promptConfirmResponses?: ReadonlyArray<boolean>;
  readonly trackTelemetry?: boolean;
  // Exit code returned by the mocked `git check-ignore` subprocess. `0` means the path is
  // ignored, any non-zero code means it is not. Only consumed by the gitignore-warning branch.
  readonly gitCheckIgnoreExitCode?: number;
  // Piped (non-TTY) stdin answer for the overwrite prompt (CLI-1865).
  readonly pipedAnswer?: string;
  // Raw argv for `legacyResolveYes`'s explicit `--yes=false` detection.
  readonly cliArgs?: ReadonlyArray<string>;
  readonly env?: Record<string, string>;
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
    format: options.format ?? "text",
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
    buildLegacyTestRuntime({
      out,
      api,
      cliConfig,
      tty,
      telemetry: telemetry?.layer,
      env: options.env,
    }),
    Layer.succeed(LegacyYesFlag, options.yes ?? false),
    Layer.succeed(CliArgs, { args: options.cliArgs ?? [] }),
    mockStdin(options.stdinIsTty ?? false, options.pipedAnswer),
    Layer.succeed(LegacyDebugLogger, {
      debug: () => Effect.void,
      http: () => Effect.void,
    }),
    // Listed after buildLegacyTestRuntime so it overrides the real spawner from BunServices.
    mockGitCheckIgnore(options.gitCheckIgnoreExitCode ?? 1),
    ConfigProvider.layer(
      ConfigProvider.fromEnv({ env: options.env ?? {}, preserveEmptyStrings: true }),
    ),
  );
  return { layer, out, telemetry };
}

function writeConfig(contents: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(join(tempRoot.current, "supabase"), { recursive: true });
    yield* fs.writeFileString(join(tempRoot.current, "supabase", "config.toml"), contents);
  });
}

function writeJsonConfig(contents: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(join(tempRoot.current, "supabase"), { recursive: true });
    yield* fs.writeFileString(join(tempRoot.current, "supabase", "config.json"), contents);
  });
}

// `findGitRoot` walks up looking for a real `.git` entry, so the gitignore branch needs one to
// exist; the `git check-ignore` call itself is mocked via `gitCheckIgnoreExitCode`.
function initGitDir() {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(join(tempRoot.current, ".git"), { recursive: true });
  });
}

function writeText(path: string, contents: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(fixturePath.dirname(path), { recursive: true });
    yield* fs.writeFileString(path, contents);
  });
}

function readText(path: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.readFileString(path);
  });
}

function writeFile(path: string, contents: string) {
  return writeText(path, contents);
}

function readFile(path: string, _encoding: "utf8") {
  return readText(path);
}

function mkdir(path: string, options: { readonly recursive?: boolean } = {}) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(path, options);
  });
}

function runFixture<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> {
  return effect;
}

describe("legacy gen signing-key integration", () => {
  it.live("prints a generated key to stdout when no signing_keys_path is configured", () => {
    const { layer, out } = setup();
    return Effect.gen(function* () {
      yield* legacyGenSigningKey({ algorithm: "ES256", append: false });

      const parsed = decodeSigningKey(out.stdoutText);
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

      const parsed = decodeSigningKey(out.stdoutText);
      expect(parsed.kty).toBe("RSA");
      expect(parsed.alg).toBe("RS256");
      expect(parsed.use).toBe("sig");
      for (const field of ["n", "e", "d", "p", "q", "dp", "dq", "qi"]) {
        expect(typeof Reflect.get(parsed, field)).toBe("string");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "ignores a stray config.json and uses the default config.toml path in the local setup hint (CLI-1961)",
    () => {
      const { layer, out } = setup();
      return Effect.gen(function* () {
        // Config loading has no concept of a JSON project config file — a
        // stray `supabase/config.json` with no `config.toml` present must be
        // treated exactly like no config at all, never as a substitute config source
        // (`gen.signing-keys-config.ts`'s `loadProjectConfig(..., { tomlOnly: true })`).
        // The CWD-relative `supabase/config.toml` is printed in this
        // "absent config" case; the hint must stay relative and must never leak the absolute
        // temp-dir path either.
        yield* writeJsonConfig("{}\n");
        yield* legacyGenSigningKey({ algorithm: "ES256", append: false });

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
        yield* runFixture(writeConfig('[auth]\nsigning_keys_path = "./signing_keys.json"\n'));
        yield* runFixture(
          writeFile(join(tempRoot.current, "supabase", "signing_keys.json"), "[]\n"),
        );

        yield* legacyGenSigningKey({ algorithm: "RS256", append: false });

        const saved = yield* runFixture(
          readFile(join(tempRoot.current, "supabase", "signing_keys.json"), "utf8"),
        );
        const parsed = decodeSigningKeys(saved);
        expect(parsed).toHaveLength(1);
        expect(parsed[0]?.alg).toBe("RS256");
        expect(out.stderrText).toContain("Do you want to overwrite the existing");
        expect(out.stderrText).toContain("JWT signing key appended to: ");
        expect(out.stderrText).toContain(join("supabase", "signing_keys.json"));
      }).pipe(Effect.provide(layer));
    },
  );

  // The overwrite prompt reads piped stdin even in non-TTY mode and honors an
  // explicit "n" — before this fix, TS returned `true` unconditionally without reading stdin at
  // all, so `echo n | supabase gen signing-key` silently overwrote instead of canceling.
  it.live("cancels the overwrite when a piped non-tty answer of 'n' is read", () => {
    const { layer, out } = setup({ stdinIsTty: false, pipedAnswer: "n" });
    return Effect.gen(function* () {
      yield* runFixture(writeConfig('[auth]\nsigning_keys_path = "./signing_keys.json"\n'));
      yield* runFixture(writeFile(join(tempRoot.current, "supabase", "signing_keys.json"), "[]\n"));

      const exit = yield* Effect.exit(legacyGenSigningKey({ algorithm: "ES256", append: false }));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const json = Formatter.formatJson(exit.cause);
        expect(json).toContain("LegacyGenSigningKeyCancelledError");
        expect(json).toContain("context canceled");
      }

      const saved = yield* runFixture(
        readFile(join(tempRoot.current, "supabase", "signing_keys.json"), "utf8"),
      );
      expect(decodeSigningKeys(saved)).toEqual([]);
      // The non-TTY prompt echoes the piped answer back to stderr after the label.
      expect(out.stderrText).toContain("[Y/n] n\n");
    }).pipe(Effect.provide(layer));
  });

  it.live("overwrites when a piped non-tty answer of 'y' is read", () => {
    const { layer, out } = setup({ stdinIsTty: false, pipedAnswer: "y" });
    return Effect.gen(function* () {
      yield* runFixture(writeConfig('[auth]\nsigning_keys_path = "./signing_keys.json"\n'));
      yield* runFixture(writeFile(join(tempRoot.current, "supabase", "signing_keys.json"), "[]\n"));

      yield* legacyGenSigningKey({ algorithm: "ES256", append: false });

      const saved = yield* runFixture(
        readFile(join(tempRoot.current, "supabase", "signing_keys.json"), "utf8"),
      );
      const parsed = decodeSigningKeys(saved);
      expect(parsed).toHaveLength(1);
      expect(out.stderrText).toContain("Do you want to overwrite the existing");
    }).pipe(Effect.provide(layer));
  });

  it.live("passes an explicit default-yes prompt for interactive overwrite", () => {
    const { layer, out } = setup({ stdinIsTty: true });
    return Effect.gen(function* () {
      yield* runFixture(writeConfig('[auth]\nsigning_keys_path = "./signing_keys.json"\n'));
      yield* runFixture(writeFile(join(tempRoot.current, "supabase", "signing_keys.json"), "[]\n"));

      yield* legacyGenSigningKey({ algorithm: "ES256", append: false });

      expect(out.promptConfirmCalls).toHaveLength(1);
      expect(out.promptConfirmCalls[0]?.opts?.defaultValue).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("appends a new key when --append is set", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      yield* runFixture(writeConfig('[auth]\nsigning_keys_path = "./signing_keys.json"\n'));
      yield* runFixture(
        writeFile(
          join(tempRoot.current, "supabase", "signing_keys.json"),
          encodeSigningKeys([
            {
              kty: "EC",
              x: "existing-x",
            },
          ]),
        ),
      );

      yield* legacyGenSigningKey({ algorithm: "ES256", append: true });

      const saved = yield* runFixture(
        readFile(join(tempRoot.current, "supabase", "signing_keys.json"), "utf8"),
      );
      const parsed = decodeSigningKeys(saved);
      expect(parsed).toHaveLength(2);
      expect(parsed[0]?.x).toBe("existing-x");
      expect(parsed[1]?.alg).toBe("ES256");
    }).pipe(Effect.provide(layer));
  });

  // The configured `signing_keys_path` file is only read/decoded when auth
  // is enabled — `gen signing-key` goes through the exact same config load
  // pipeline as `gen bearer-jwt` (both call it), so it is subject to the
  // same gate: with `auth.enabled = false`, a malformed signing-keys file is
  // never read at all, so the command succeeds instead of failing on a
  // decode error.
  it.live("does not fail on a malformed signing keys file when [auth] enabled is false", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      yield* runFixture(
        writeConfig('[auth]\nenabled = false\nsigning_keys_path = "./signing_keys.json"\n'),
      );
      yield* runFixture(
        writeFile(join(tempRoot.current, "supabase", "signing_keys.json"), "not valid json {\n"),
      );

      const exit = yield* Effect.exit(legacyGenSigningKey({ algorithm: "ES256", append: true }));
      expect(Exit.isFailure(exit)).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  // Same finding, the more surprising half: the signing keys never advance
  // past the default single-key array when auth is disabled, so `--append`
  // appends to (and the resulting write clobbers) that phantom default set,
  // NOT the file's real content: appending under `auth.enabled = false`
  // against a file containing a genuine custom key overwrote it with the
  // default ES256 key plus the newly generated one, discarding the original
  // entry entirely.
  it.live(
    "appends to (and overwrites with) the built-in default key, ignoring the real file content, when [auth] enabled is false",
    () => {
      const { layer } = setup();
      return Effect.gen(function* () {
        yield* runFixture(
          writeConfig('[auth]\nenabled = false\nsigning_keys_path = "./signing_keys.json"\n'),
        );
        yield* runFixture(
          writeFile(
            join(tempRoot.current, "supabase", "signing_keys.json"),
            encodeSigningKeys([{ kty: "EC", kid: "existing-key", x: "existing-x" }]),
          ),
        );

        yield* legacyGenSigningKey({ algorithm: "ES256", append: true });

        const saved = yield* runFixture(
          readFile(join(tempRoot.current, "supabase", "signing_keys.json"), "utf8"),
        );
        const parsed = decodeSigningKeys(saved);
        expect(parsed).toHaveLength(2);
        expect(parsed[0]?.kid).toBe(LEGACY_DEFAULT_SIGNING_KEY.kid);
        expect(parsed.some((key) => key["kid"] === "existing-key")).toBe(false);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("fails when the configured signing keys file is not a JSON array of objects", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      yield* runFixture(writeConfig('[auth]\nsigning_keys_path = "./signing_keys.json"\n'));
      yield* runFixture(
        writeFile(join(tempRoot.current, "supabase", "signing_keys.json"), "[1]\n"),
      );

      const exit = yield* Effect.exit(legacyGenSigningKey({ algorithm: "ES256", append: false }));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const json = Formatter.formatJson(exit.cause);
        expect(json).toContain("LegacyGenSigningKeyDecodeError");
        expect(json).toContain("failed to decode signing keys");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with a config parse error when config.toml is malformed", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      yield* writeConfig("not valid toml ][");

      const exit = yield* Effect.exit(legacyGenSigningKey({ algorithm: "ES256", append: false }));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Formatter.formatJson(exit.cause)).toContain("LegacyGenSigningKeyConfigParseError");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("fails when the configured signing keys file is not a JSON array at all", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      yield* runFixture(writeConfig('[auth]\nsigning_keys_path = "./signing_keys.json"\n'));
      yield* runFixture(writeFile(join(tempRoot.current, "supabase", "signing_keys.json"), "{}\n"));

      const exit = yield* Effect.exit(legacyGenSigningKey({ algorithm: "ES256", append: false }));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const json = Formatter.formatJson(exit.cause);
        expect(json).toContain("LegacyGenSigningKeyDecodeError");
        expect(json).toContain("expected a JSON array");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("resolves and displays an absolute signing_keys_path as configured", () => {
    const { layer, out } = setup();
    return Effect.gen(function* () {
      const absoluteKeysPath = join(tempRoot.current, "supabase", "absolute_keys.json");
      yield* runFixture(writeConfig(`[auth]\nsigning_keys_path = "${absoluteKeysPath}"\n`));
      yield* writeFile(absoluteKeysPath, "[]\n");

      yield* legacyGenSigningKey({ algorithm: "ES256", append: false });

      const saved = yield* readFile(absoluteKeysPath, "utf8");
      const parsed = decodeSigningKeys(saved);
      expect(parsed).toHaveLength(1);
      // An absolute configured path is displayed verbatim, matching Go.
      expect(out.stderrText).toContain(absoluteKeysPath);
    }).pipe(Effect.provide(layer));
  });

  it.live("resolves signing_keys_path from the injected shell environment", () => {
    const { layer, out } = setup({ env: { KEYS_PATH: "./shell-signing-keys.json" } });
    return Effect.gen(function* () {
      yield* runFixture(writeConfig('[auth]\nsigning_keys_path = "env(KEYS_PATH)"\n'));
      const keysPath = join(tempRoot.current, "supabase", "shell-signing-keys.json");
      yield* writeFile(keysPath, "[]\n");

      yield* legacyGenSigningKey({ algorithm: "ES256", append: false });

      expect(decodeSigningKeys(yield* readFile(keysPath, "utf8"))).toHaveLength(1);
      expect(out.stderrText).toContain("supabase/shell-signing-keys.json");
    }).pipe(Effect.provide(layer));
  });

  it.live("fails when signing_keys_path is configured but the file is missing", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      yield* runFixture(writeConfig('[auth]\nsigning_keys_path = "./signing_keys.json"\n'));

      const exit = yield* Effect.exit(legacyGenSigningKey({ algorithm: "ES256", append: false }));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const json = Formatter.formatJson(exit.cause);
        expect(json).toContain("LegacyGenSigningKeyReadError");
        expect(json).toContain("failed to read signing keys");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("returns context canceled when a TTY user declines overwrite", () => {
    const { layer } = setup({ stdinIsTty: true, promptConfirmResponses: [false] });
    return Effect.gen(function* () {
      yield* runFixture(writeConfig('[auth]\nsigning_keys_path = "./signing_keys.json"\n'));
      yield* runFixture(writeFile(join(tempRoot.current, "supabase", "signing_keys.json"), "[]\n"));

      const exit = yield* Effect.exit(legacyGenSigningKey({ algorithm: "ES256", append: false }));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const json = Formatter.formatJson(exit.cause);
        expect(json).toContain("LegacyGenSigningKeyCancelledError");
        expect(json).toContain("context canceled");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("warns when the configured signing key path is not gitignored", () => {
    // git check-ignore exits non-zero when the path is NOT ignored.
    const { layer, out } = setup({ gitCheckIgnoreExitCode: 1 });
    return Effect.gen(function* () {
      yield* runFixture(writeConfig('[auth]\nsigning_keys_path = "./signing_keys.json"\n'));
      yield* initGitDir();
      yield* runFixture(writeFile(join(tempRoot.current, "supabase", "signing_keys.json"), "[]\n"));

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
        yield* runFixture(writeConfig('[auth]\nsigning_keys_path = "./signing_keys.json"\n'));
        yield* initGitDir();
        yield* runFixture(
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
      yield* runFixture(writeConfig('[auth]\nsigning_keys_path = "./signing_keys.json"\n'));
      yield* runFixture(writeFile(join(tempRoot.current, "supabase", "signing_keys.json"), "[]\n"));

      yield* legacyGenSigningKey({ algorithm: "ES256", append: false });

      expect(out.stderrText).toContain("[Y/n] y");
    }).pipe(Effect.provide(layer));
  });

  // This command has no structured json/stream-json output (SIDE_EFFECTS.md), so a real TTY
  // requesting machine output is an unsupported combination — fail closed on this destructive,
  // irreversible overwrite rather than silently defaulting to yes with no prompt at all.
  it.live(
    "declines the overwrite without prompting on a tty when --output-format is not text",
    () => {
      const { layer, out } = setup({ format: "json", stdinIsTty: true });
      return Effect.gen(function* () {
        yield* runFixture(writeConfig('[auth]\nsigning_keys_path = "./signing_keys.json"\n'));
        yield* runFixture(
          writeFile(join(tempRoot.current, "supabase", "signing_keys.json"), "[]\n"),
        );

        const exit = yield* Effect.exit(legacyGenSigningKey({ algorithm: "ES256", append: false }));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const json = Formatter.formatJson(exit.cause);
          expect(json).toContain("LegacyGenSigningKeyCancelledError");
        }

        const saved = yield* runFixture(
          readFile(join(tempRoot.current, "supabase", "signing_keys.json"), "utf8"),
        );
        expect(decodeSigningKeys(saved)).toEqual([]);
        expect(out.promptConfirmCalls).toHaveLength(0);
      }).pipe(Effect.provide(layer));
    },
  );

  // CLI-1865 follow-up: `legacyPromptYesNo` checks `output.format !== "text"` BEFORE it
  // checks TTY, so a non-TTY invocation under `json`/`stream-json` must not fall into that
  // early return — this command has no structured json/stream-json payload, so a piped
  // answer must be honored the same as text mode. Before this fix, a piped "n" here was
  // silently ignored and the file was overwritten with the default (true).
  it.live("honors a piped non-tty 'n' even when --output-format is json", () => {
    const { layer, out } = setup({ format: "json", stdinIsTty: false, pipedAnswer: "n" });
    return Effect.gen(function* () {
      yield* runFixture(writeConfig('[auth]\nsigning_keys_path = "./signing_keys.json"\n'));
      yield* runFixture(writeFile(join(tempRoot.current, "supabase", "signing_keys.json"), "[]\n"));

      const exit = yield* Effect.exit(legacyGenSigningKey({ algorithm: "ES256", append: false }));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Formatter.formatJson(exit.cause)).toContain("LegacyGenSigningKeyCancelledError");
      }

      const saved = yield* runFixture(
        readFile(join(tempRoot.current, "supabase", "signing_keys.json"), "utf8"),
      );
      expect(decodeSigningKeys(saved)).toEqual([]);
      expect(out.promptConfirmCalls).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.live("honors a piped non-tty 'y' when --output-format is stream-json", () => {
    const { layer } = setup({ format: "stream-json", stdinIsTty: false, pipedAnswer: "y" });
    return Effect.gen(function* () {
      yield* runFixture(writeConfig('[auth]\nsigning_keys_path = "./signing_keys.json"\n'));
      yield* runFixture(writeFile(join(tempRoot.current, "supabase", "signing_keys.json"), "[]\n"));

      yield* legacyGenSigningKey({ algorithm: "ES256", append: false });

      const saved = yield* runFixture(
        readFile(join(tempRoot.current, "supabase", "signing_keys.json"), "utf8"),
      );
      expect(decodeSigningKeys(saved)).toHaveLength(1);
    }).pipe(Effect.provide(layer));
  });

  it.live("honors SUPABASE_YES and overwrites even when a piped 'n' is present", () => {
    // Go reads `viper.GetBool("YES")` (incl. the SUPABASE_YES env var) BEFORE scanning
    // stdin (`console.go:71`), so `SUPABASE_YES=1 printf 'n\n' | supabase gen signing-key`
    // auto-confirms and overwrites rather than consuming the piped `n`. The handler
    // resolves `yes` via `legacyResolveYes`, not the raw --yes flag.
    const { layer } = setup({ stdinIsTty: false, pipedAnswer: "n", env: { SUPABASE_YES: "1" } });
    return Effect.gen(function* () {
      yield* runFixture(writeConfig('[auth]\nsigning_keys_path = "./signing_keys.json"\n'));
      yield* runFixture(writeFile(join(tempRoot.current, "supabase", "signing_keys.json"), "[]\n"));

      yield* legacyGenSigningKey({ algorithm: "ES256", append: false });

      const saved = yield* runFixture(
        readFile(join(tempRoot.current, "supabase", "signing_keys.json"), "utf8"),
      );
      const parsed = decodeSigningKeys(saved);
      expect(parsed).toHaveLength(1);
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "auto-confirms from SUPABASE_YES in the project .env, even with a piped 'n' (CLI-1878)",
    () => {
      // SUPABASE_YES lives only in supabase/.env, not the shell. The project
      // `.env` files load before the overwrite prompt reads the yes flag, so
      // the overwrite auto-confirms and the piped `n` is never consumed —
      // same precedence as the shell-env case above.
      //
      // Defensively clear a shell SUPABASE_YES: this test must prove the project-.env source
      // specifically, not accidentally pass because a prior test in this file left the shell
      // env set (the sibling shell-env tests above save/restore theirs).
      const { layer } = setup({ stdinIsTty: false, pipedAnswer: "n", env: {} });
      return Effect.gen(function* () {
        yield* runFixture(writeConfig('[auth]\nsigning_keys_path = "./signing_keys.json"\n'));
        yield* runFixture(
          writeFile(join(tempRoot.current, "supabase", "signing_keys.json"), "[]\n"),
        );
        yield* runFixture(
          writeFile(join(tempRoot.current, "supabase", ".env"), "SUPABASE_YES=true\n"),
        );

        yield* legacyGenSigningKey({ algorithm: "ES256", append: false });

        const saved = yield* runFixture(
          readFile(join(tempRoot.current, "supabase", "signing_keys.json"), "utf8"),
        );
        const parsed = decodeSigningKeys(saved);
        expect(parsed).toHaveLength(1);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("an explicit --yes=false overrides SUPABASE_YES and honors a piped 'n'", () => {
    const { layer } = setup({
      stdinIsTty: false,
      pipedAnswer: "n",
      cliArgs: ["gen", "signing-key", "--yes=false"],
      env: { SUPABASE_YES: "1" },
    });
    return Effect.gen(function* () {
      yield* runFixture(writeConfig('[auth]\nsigning_keys_path = "./signing_keys.json"\n'));
      yield* runFixture(writeFile(join(tempRoot.current, "supabase", "signing_keys.json"), "[]\n"));

      const exit = yield* Effect.exit(legacyGenSigningKey({ algorithm: "ES256", append: false }));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Formatter.formatJson(exit.cause)).toContain("LegacyGenSigningKeyCancelledError");
      }

      const saved = yield* runFixture(
        readFile(join(tempRoot.current, "supabase", "signing_keys.json"), "utf8"),
      );
      expect(decodeSigningKeys(saved)).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.live("flushes telemetry state after the command finishes", () => {
    const { layer, telemetry } = setup({ trackTelemetry: true });
    return Effect.gen(function* () {
      yield* legacyGenSigningKey({ algorithm: "ES256", append: false });
      expect(telemetry?.flushed).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("flushes telemetry state even when the project .env is malformed (Codex review)", () => {
    // Go attaches the telemetry service in root's `PersistentPreRunE` (cmd/root.go:131-155),
    // before this command's own `RunE` runs `flags.LoadConfig` (signingkeys.go:99), so
    // `service.Capture` still fires even when that project-.env load fails. The project-env
    // resolution here must live inside the `Effect.ensuring(telemetryState.flush)`-wrapped
    // block for the same reason — locks in that fix.
    const { layer, telemetry } = setup({ trackTelemetry: true });
    return Effect.gen(function* () {
      yield* runFixture(mkdir(join(tempRoot.current, "supabase"), { recursive: true }));
      yield* runFixture(writeFile(join(tempRoot.current, "supabase", ".env"), "!=broken\n"));

      const exit = yield* Effect.exit(legacyGenSigningKey({ algorithm: "ES256", append: false }));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Formatter.formatJson(exit.cause)).toContain("LegacyDbConfigLoadError");
      }
      expect(telemetry?.flushed).toBe(true);
    }).pipe(Effect.provide(layer));
  });
});
