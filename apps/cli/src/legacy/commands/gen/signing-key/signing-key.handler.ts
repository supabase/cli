import { generateKeyPairSync, randomUUID } from "node:crypto";
import { styleText } from "node:util";
import { loadProjectConfig } from "@supabase/config";
import { Effect, FileSystem, Option, Path } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { LegacyCliConfig } from "../../../config/legacy-cli-config.service.ts";
import { findGitRootPath } from "../../../../shared/git/git-root.ts";
import { LegacyDebugLogger } from "../../../shared/legacy-debug-logger.service.ts";
import { legacyPromptYesNo } from "../../../shared/legacy-prompt-yes-no.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import { legacyResolveYes } from "../../../../shared/legacy/global-flags.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import { Tty } from "../../../../shared/runtime/tty.service.ts";
import type { LegacyGenSigningKeyFlags } from "./signing-key.command.ts";
import {
  LegacyGenSigningKeyCancelledError,
  LegacyGenSigningKeyConfigParseError,
  LegacyGenSigningKeyGenerateError,
  LegacyGenSigningKeyDecodeError,
  LegacyGenSigningKeyReadError,
  LegacyGenSigningKeyWriteError,
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

type StoredSigningKeyJwk = Readonly<Record<string, unknown>>;

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
): Effect.Effect<string, LegacyGenSigningKeyGenerateError> {
  const candidate = value[field];
  return typeof candidate === "string"
    ? Effect.succeed(candidate)
    : Effect.fail(
        new LegacyGenSigningKeyGenerateError({
          message: `failed to generate signing key: missing jwk field ${field}`,
        }),
      );
}

function readJwkArray(
  value: unknown,
): Effect.Effect<ReadonlyArray<StoredSigningKeyJwk>, LegacyGenSigningKeyDecodeError> {
  if (!Array.isArray(value)) {
    return Effect.fail(
      new LegacyGenSigningKeyDecodeError({
        message: "failed to decode signing keys: expected a JSON array",
      }),
    );
  }
  for (const item of value) {
    if (!isRecord(item)) {
      return Effect.fail(
        new LegacyGenSigningKeyDecodeError({
          message: "failed to decode signing keys: expected a JSON array of objects",
        }),
      );
    }
  }
  return Effect.succeed(value);
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
        new LegacyGenSigningKeyGenerateError({
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
      new LegacyGenSigningKeyGenerateError({
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

const loadSigningKeysConfig = Effect.fnUntraced(function* (cwd: string) {
  const path = yield* Path.Path;
  const loaded = yield* loadProjectConfig(cwd).pipe(
    Effect.catchTag("ProjectConfigParseError", (cause) =>
      Effect.fail(
        new LegacyGenSigningKeyConfigParseError({
          message: `failed to parse ${cause.path}: ${String(cause.cause)}`,
        }),
      ),
    ),
  );
  if (loaded === null) {
    return {
      configDisplayPath: path.join("supabase", "config.toml"),
      configured: Option.none(),
    } satisfies ResolvedSigningKeysConfig;
  }

  // Go displays the CWD-relative `supabase/config.toml` (utils.ConfigPath), never an absolute
  // path. `@supabase/config` always resolves `loaded.path` to an absolute path, so relativize it
  // back against the project root to match Go's output.
  const projectRoot = path.dirname(path.dirname(loaded.path));
  const configDisplayPath = path.relative(projectRoot, loaded.path);

  const configuredPath = loaded.config.auth.signing_keys_path;
  if (configuredPath === undefined || configuredPath.length === 0) {
    return {
      configDisplayPath,
      configured: Option.none(),
    } satisfies ResolvedSigningKeysConfig;
  }

  const resolvedPath = path.isAbsolute(configuredPath)
    ? configuredPath
    : path.join(path.dirname(loaded.path), configuredPath);
  const displayPath = path.isAbsolute(configuredPath)
    ? configuredPath
    : path.relative(projectRoot, resolvedPath);
  const fs = yield* FileSystem.FileSystem;
  const raw = yield* fs.readFileString(resolvedPath).pipe(
    Effect.mapError(
      (cause) =>
        new LegacyGenSigningKeyReadError({
          message: `failed to read signing keys: ${String(cause)}`,
        }),
    ),
  );
  const decoded = yield* Effect.try({
    try: () => JSON.parse(raw),
    catch: (cause) =>
      new LegacyGenSigningKeyDecodeError({
        message: `failed to decode signing keys: ${String(cause)}`,
      }),
  });
  const existingKeys = yield* readJwkArray(decoded);
  return {
    configDisplayPath,
    configured: Option.some({ actualPath: resolvedPath, displayPath, existingKeys }),
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

export const legacyGenSigningKey = Effect.fn("legacy.gen.signing-key")(function* (
  flags: LegacyGenSigningKeyFlags,
) {
  const cliConfig = yield* LegacyCliConfig;
  const debugLogger = yield* LegacyDebugLogger;
  const telemetryState = yield* LegacyTelemetryState;
  const output = yield* Output;
  const tty = yield* Tty;
  const yes = yield* legacyResolveYes;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const emphasize = (text: string) => styleIfTty(tty.stdoutIsTty, "bold", text);
  const warnText = (text: string) => styleIfTty(tty.stdoutIsTty, "yellow", text);

  return yield* Effect.gen(function* () {
    // Match Go's order: LoadConfig validates the configured signing-keys file before any key is
    // generated, so a broken config fails fast without doing throwaway crypto work.
    const signingKeysConfig = yield* loadSigningKeysConfig(cliConfig.workdir);
    const key = yield* generatePrivateKey(flags.algorithm);
    const configured = signingKeysConfig.configured;

    if (Option.isNone(configured)) {
      yield* output.raw(`${JSON.stringify(key)}\n`, "stdout");
      const defaultPath = path.join("supabase", "signing_keys.json");
      yield* output.raw(
        `\nTo enable JWT signing keys in your local project:\n1. Save the generated key to ${emphasize(defaultPath)}\n2. Update your ${emphasize(signingKeysConfig.configDisplayPath)} with the new keys path\n\n[auth]\nsigning_keys_path = "./signing_keys.json"\n\n`,
        "stderr",
      );
      return;
    }

    const nextKeys = flags.append
      ? [...configured.value.existingKeys, key]
      : yield* Effect.gen(function* () {
          // `legacyPromptYesNo` silently returns the default (true) for any non-text
          // `--output-format`, but this command has no structured json/stream-json output
          // (SIDE_EFFECTS.md) — that combination only arises from a real interactive TTY
          // explicitly requesting machine output. Fail closed rather than silently
          // overwriting irrecoverable key material.
          const confirmed =
            !yes && tty.stdinIsTty && output.format !== "text"
              ? false
              : yield* legacyPromptYesNo(
                  // `legacyPromptYesNo` checks `output.format !== "text"` BEFORE it checks
                  // TTY, so a non-TTY (piped or empty) invocation under `json`/`stream-json`
                  // would otherwise hit that check first and return the default without
                  // ever reading stdin. Go's `console.PromptYesNo`
                  // (apps/cli-go/internal/utils/console.go:64-82) has no concept of output
                  // format at all — it always reads piped stdin — so a piped `y`/`n` answer
                  // must be honored here the same as in text mode. Present a text-shaped
                  // view of `output` to reach that read; `raw`/`promptConfirm` write the
                  // prompt to stderr under every `Output` layer, so this never touches the
                  // machine-readable stdout payload.
                  output.format === "text" ? output : { ...output, format: "text" },
                  yes,
                  `Do you want to overwrite the existing ${emphasize(configured.value.displayPath)} file?`,
                  true,
                );
          if (!confirmed) {
            return yield* Effect.fail(
              new LegacyGenSigningKeyCancelledError({ message: "context canceled" }),
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
            new LegacyGenSigningKeyWriteError({
              message: `failed to open signing key: ${String(cause)}`,
            }),
        ),
      );

    yield* output.raw(
      `JWT signing key appended to: ${emphasize(configured.value.displayPath)} (now contains ${nextKeys.length} keys)\n`,
      "stderr",
    );

    if (nextKeys.length === 1) {
      const ignored = yield* isGitIgnored(configured.value.actualPath, cliConfig.workdir).pipe(
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
