import { generateKeyPairSync, randomUUID } from "node:crypto";
import { styleText } from "node:util";
import { Effect, FileSystem, Option, Path } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { CommandSettings } from "../../../config/command-settings.service.ts";
import { emitSuccessTrailer } from "../../../shared/cli/success-trailer.ts";
import { findGitRootPath } from "../../../shared/git/git-root.ts";
import { loadProjectEnv } from "../../../command-internal/db-config.toml-read.ts";
import { DebugLogger } from "../../../command-internal/debug-logger.service.ts";
import { DEFAULT_SIGNING_KEY } from "../../../command-internal/go-jwt.ts";
import { promptYesNo } from "../../../command-internal/prompt-yes-no.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import { resolveYesWithProjectEnv } from "../../../command-internal/global-flags.ts";
import { CONTEXT_CANCELED_MESSAGE } from "../../../shared/output/errors.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { Tty } from "../../../shared/runtime/tty.service.ts";
import {
  readSigningKeysFile,
  resolveSigningKeysConfigPaths,
  type StoredSigningKeyJwk,
} from "../gen.signing-keys-config.ts";
import type { GenSigningKeyFlags } from "./signing-key.command.ts";
import {
  GenSigningKeyCancelledError,
  GenSigningKeyConfigParseError,
  GenSigningKeyGenerateError,
  GenSigningKeyDecodeError,
  GenSigningKeyReadError,
  GenSigningKeyWriteError,
} from "./signing-key.errors.ts";

type SigningAlgorithm = "ES256" | "RS256";

interface SigningKeyJwk {
  readonly kty: "EC" | "RSA";
  readonly kid: string;
  readonly use: "sig";
  readonly key_ops: ReadonlyArray<"sign" | "verify">;
  readonly alg: SigningAlgorithm;
  readonly ext: true;
  readonly crv?: "P-256";
  readonly x?: string;
  readonly y?: string;
  readonly d: string;
  readonly n?: string;
  readonly e?: string;
  readonly p?: string;
  readonly q?: string;
  readonly dp?: string;
  readonly dq?: string;
  readonly qi?: string;
}

interface ResolvedSigningKeysConfig {
  readonly configDisplayPath: string;
  readonly configured: Option.Option<{
    actualPath: string;
    displayPath: string;
    existingKeys: ReadonlyArray<StoredSigningKeyJwk>;
  }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readStringField(
  value: Record<string, unknown>,
  field: string,
): Effect.Effect<string, GenSigningKeyGenerateError> {
  const candidate = value[field];
  return typeof candidate === "string"
    ? Effect.succeed(candidate)
    : Effect.fail(
        new GenSigningKeyGenerateError({
          message: `failed to generate signing key: missing jwk field ${field}`,
        }),
      );
}

function styleIfTty(
  enabled: boolean,
  format: Parameters<typeof styleText>[0],
  text: string,
): string {
  return enabled ? styleText(format, text) : text;
}

const generatePrivateKey = Effect.fnUntraced(function* (algorithm: SigningAlgorithm) {
  const keyId = randomUUID();

  if (algorithm === "RS256") {
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicExponent: 0x10001,
    });
    const exported = privateKey.export({ format: "jwk" });
    if (!isRecord(exported)) {
      return yield* Effect.fail(
        new GenSigningKeyGenerateError({
          message: "failed to generate signing key: rsa jwk export failed",
        }),
      );
    }
    return {
      kty: "RSA",
      kid: keyId,
      use: "sig",
      key_ops: ["sign", "verify"],
      alg: "RS256",
      ext: true,
      n: yield* readStringField(exported, "n"),
      e: yield* readStringField(exported, "e"),
      d: yield* readStringField(exported, "d"),
      p: yield* readStringField(exported, "p"),
      q: yield* readStringField(exported, "q"),
      dp: yield* readStringField(exported, "dp"),
      dq: yield* readStringField(exported, "dq"),
      qi: yield* readStringField(exported, "qi"),
    } satisfies SigningKeyJwk;
  }

  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const exported = privateKey.export({ format: "jwk" });
  if (!isRecord(exported)) {
    return yield* Effect.fail(
      new GenSigningKeyGenerateError({
        message: "failed to generate signing key: ec jwk export failed",
      }),
    );
  }
  return {
    kty: "EC",
    kid: keyId,
    use: "sig",
    key_ops: ["sign", "verify"],
    alg: "ES256",
    ext: true,
    d: yield* readStringField(exported, "d"),
    crv: "P-256",
    x: yield* readStringField(exported, "x"),
    y: yield* readStringField(exported, "y"),
  } satisfies SigningKeyJwk;
});

// Only reads the `signing_keys_path` file when auth is enabled; otherwise `--append` appends
// to (and an overwrite clobbers) the default single-key array instead of the file's real
// content. Surprising but established behavior — matches `gen bearer-jwt`'s own gate.
const loadSigningKeysConfig = Effect.fnUntraced(function* (cwd: string) {
  const paths = yield* resolveSigningKeysConfigPaths(
    cwd,
    (message) => new GenSigningKeyConfigParseError({ message }),
  );
  if (Option.isNone(paths.signingKeysPath)) {
    return {
      configDisplayPath: paths.configDisplayPath,
      configured: Option.none(),
    } satisfies ResolvedSigningKeysConfig;
  }

  const { actualPath, displayPath } = paths.signingKeysPath.value;
  const existingKeys = paths.authEnabled
    ? yield* readSigningKeysFile(
        actualPath,
        (message) => new GenSigningKeyReadError({ message }),
        (message) => new GenSigningKeyDecodeError({ message }),
      )
    : [{ ...DEFAULT_SIGNING_KEY }];
  return {
    configDisplayPath: paths.configDisplayPath,
    configured: Option.some({ actualPath, displayPath, existingKeys }),
  } satisfies ResolvedSigningKeysConfig;
});

const isGitIgnored = Effect.fnUntraced(function* (filePath: string, searchFrom: string) {
  const path = yield* Path.Path;
  const gitRoot = yield* Effect.tryPromise(() => findGitRootPath(searchFrom)).pipe(Effect.orDie);
  if (gitRoot === undefined) {
    return Option.none<boolean>();
  }

  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const relative = path.relative(gitRoot, filePath).replaceAll("\\", "/");
  const command = ChildProcess.make(
    "git",
    // `--` terminates flag parsing so a path beginning with `-` is never read as a git option.
    ["-C", gitRoot, "check-ignore", "--quiet", "--", relative],
    {
      detached: true,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    },
  );

  return yield* spawner
    .exitCode(command)
    .pipe(Effect.map((exitCode) => Option.some(Number(exitCode) === 0)));
});

export const genSigningKey = Effect.fn("gen.signing-key")(function* (flags: GenSigningKeyFlags) {
  const cliSettings = yield* CommandSettings;
  const debugLogger = yield* DebugLogger;
  const telemetryState = yield* TelemetryState;
  const output = yield* Output;
  const tty = yield* Tty;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const emphasize = (text: string) => styleIfTty(tty.stdoutIsTty, "bold", text);
  const warnText = (text: string) => styleIfTty(tty.stdoutIsTty, "yellow", text);

  return yield* Effect.gen(function* () {
    // Loaded here (not above) so a malformed `.env` still flushes telemetry: `SUPABASE_YES`
    // in `supabase/.env` must be able to auto-confirm the overwrite prompt below.
    const projectEnv = yield* loadProjectEnv(fs, path, cliSettings.workdir);
    const yes = yield* resolveYesWithProjectEnv(projectEnv);
    // The configured signing-keys file is validated before any key is
    // generated, so a broken config fails fast without doing throwaway crypto work.
    const signingKeysConfig = yield* loadSigningKeysConfig(cliSettings.workdir);
    const key = yield* generatePrivateKey(flags.algorithm);
    const configured = signingKeysConfig.configured;

    if (Option.isNone(configured)) {
      yield* output.raw(`${JSON.stringify(key)}\n`, "stdout");
      const defaultPath = path.join("supabase", "signing_keys.json");
      yield* emitSuccessTrailer(
        `\nTo enable JWT signing keys in your local project:\n1. Save the generated key to ${emphasize(defaultPath)}\n2. Update your ${emphasize(signingKeysConfig.configDisplayPath)} with the new keys path\n\n[auth]\nsigning_keys_path = "./signing_keys.json"\n\n`,
      );
      return;
    }

    const nextKeys = flags.append
      ? [...configured.value.existingKeys, key]
      : yield* Effect.gen(function* () {
          // Fail closed instead of relying on `promptYesNo`'s default-true fallback: this
          // command has no structured json/stream-json output, so silently overwriting key
          // material on a machine-output TTY would be worse than erroring.
          const confirmed =
            !yes && tty.stdinIsTty && output.format !== "text"
              ? false
              : yield* promptYesNo(
                  // Presents a text-shaped `output` so `promptYesNo` reads piped stdin instead
                  // of short-circuiting on `output.format !== "text"`; the prompt itself always
                  // writes to stderr, so this never touches the machine-readable stdout payload.
                  output.format === "text" ? output : { ...output, format: "text" },
                  yes,
                  `Do you want to overwrite the existing ${emphasize(configured.value.displayPath)} file?`,
                  true,
                );
          if (!confirmed) {
            return yield* Effect.fail(
              new GenSigningKeyCancelledError({ message: CONTEXT_CANCELED_MESSAGE }),
            );
          }
          return [key];
        });

    yield* fs
      .writeFileString(configured.value.actualPath, `${JSON.stringify(nextKeys, null, 2)}\n`, {
        mode: 0o600,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new GenSigningKeyWriteError({
              message: `failed to open signing key: ${String(cause)}`,
            }),
        ),
      );

    yield* output.raw(
      `JWT signing key appended to: ${emphasize(configured.value.displayPath)} (now contains ${nextKeys.length} keys)\n`,
      "stderr",
    );

    if (nextKeys.length === 1) {
      const ignored = yield* isGitIgnored(configured.value.actualPath, cliSettings.workdir).pipe(
        Effect.tapError((cause) => debugLogger.debug(String(cause))),
        Effect.orElseSucceed(() => Option.none<boolean>()),
      );
      if (Option.isSome(ignored) && !ignored.value) {
        yield* output.raw(
          `${warnText("IMPORTANT:")} Add your signing key path to .gitignore to prevent committing to version control.\n`,
          "stderr",
        );
      }
    }
  }).pipe(Effect.ensuring(telemetryState.flush));
});
