import { generateKeyPairSync, randomUUID } from "node:crypto";
import { styleText } from "node:util";
import { loadProjectConfig } from "@supabase/config";
import { Effect, FileSystem, Option, Path } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { LegacyCliConfig } from "../../../config/legacy-cli-config.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import { LegacyYesFlag } from "../../../../shared/legacy/global-flags.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import { Tty } from "../../../../shared/runtime/tty.service.ts";
import type { LegacyGenSigningKeyFlags } from "./signing-key.command.ts";
import {
  LegacyGenSigningKeyCancelledError,
  LegacyGenSigningKeyConfigParseError,
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readStringField(
  value: Record<string, unknown>,
  field: string,
): Effect.Effect<string, never, never> {
  const candidate = value[field];
  return typeof candidate === "string"
    ? Effect.succeed(candidate)
    : Effect.die(`missing jwk field: ${field}`);
}

function isStoredSigningKeyJwk(value: unknown): value is StoredSigningKeyJwk {
  return isRecord(value);
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
    if (!isStoredSigningKeyJwk(item)) {
      return Effect.fail(
        new LegacyGenSigningKeyDecodeError({
          message: "failed to decode signing keys: expected a JSON array of objects",
        }),
      );
    }
  }
  return Effect.succeed(value);
}

interface ConfirmTty {
  readonly stdinIsTty: boolean;
}

interface ConfirmOutput {
  readonly raw: (text: string, stream?: "stdout" | "stderr") => Effect.Effect<void>;
  readonly promptConfirm: (message: string) => Effect.Effect<boolean, unknown>;
}

function styleIfTty(
  enabled: boolean,
  format: Parameters<typeof styleText>[0],
  text: string,
): string {
  return enabled ? styleText(format, text) : text;
}

const generatePrivateKey = Effect.fn("legacy.gen.signing-key.generate")(function* (
  algorithm: SigningAlgorithm,
) {
  const keyId = randomUUID();

  if (algorithm === "RS256") {
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicExponent: 0x10001,
    });
    const exported = privateKey.export({ format: "jwk" });
    if (!isRecord(exported)) {
      return yield* Effect.die("rsa jwk export failed");
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
    return yield* Effect.die("ec jwk export failed");
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

const loadSigningKeysConfig = Effect.fn("legacy.gen.signing-key.config")(function* (cwd: string) {
  const path = yield* Path.Path;
  const loaded = yield* loadProjectConfig(cwd).pipe(
    Effect.catchTag("ProjectConfigParseError", (cause) =>
      Effect.fail(
        new LegacyGenSigningKeyConfigParseError({
          message: `failed to parse supabase/config.toml: ${String(cause.cause)}`,
        }),
      ),
    ),
  );
  if (loaded === null) {
    return Option.none<{
      actualPath: string;
      displayPath: string;
      existingKeys: ReadonlyArray<StoredSigningKeyJwk>;
    }>();
  }

  const configuredPath = loaded.config.auth.signing_keys_path;
  if (configuredPath === undefined || configuredPath.length === 0) {
    return Option.none<{
      actualPath: string;
      displayPath: string;
      existingKeys: ReadonlyArray<StoredSigningKeyJwk>;
    }>();
  }

  const projectRoot = path.dirname(path.dirname(loaded.path));
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
  return Option.some({ actualPath: resolvedPath, displayPath, existingKeys });
});

const findGitRoot = Effect.fn("legacy.gen.signing-key.find-git-root")(function* (start: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  let current = path.resolve(start);
  const root = path.parse(current).root;

  while (true) {
    if (yield* fs.exists(path.join(current, ".git")).pipe(Effect.orElseSucceed(() => false))) {
      return Option.some(current);
    }
    if (current === root) {
      return Option.none<string>();
    }
    current = path.dirname(current);
  }
});

const isGitIgnored = Effect.fn("legacy.gen.signing-key.gitignored")(function* (
  filePath: string,
  searchFrom: string,
) {
  const path = yield* Path.Path;
  const gitRoot = yield* findGitRoot(searchFrom);
  if (Option.isNone(gitRoot)) {
    return Option.none<boolean>();
  }

  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const relative = path.relative(gitRoot.value, filePath).replaceAll("\\", "/");
  const command = ChildProcess.make(
    "git",
    ["-C", gitRoot.value, "check-ignore", "--quiet", relative],
    {
      detached: true,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    },
  );

  return yield* spawner.exitCode(command).pipe(
    Effect.map((exitCode) => Option.some(Number(exitCode) === 0)),
    Effect.orElseSucceed(() => Option.none<boolean>()),
  );
});

const confirmOverwrite = Effect.fn("legacy.gen.signing-key.confirm")(function* (
  title: string,
  yes: boolean,
  tty: ConfirmTty,
  output: ConfirmOutput,
) {
  if (yes) {
    yield* output.raw(`${title} [Y/n] y\n`, "stderr");
    return true;
  }
  if (!tty.stdinIsTty) {
    yield* output.raw(`${title} [Y/n] \n`, "stderr");
    return true;
  }
  return yield* output.promptConfirm(title).pipe(Effect.orElseSucceed(() => false));
});

export const legacyGenSigningKey = Effect.fn("legacy.gen.signing-key")(function* (
  flags: LegacyGenSigningKeyFlags,
) {
  const cliConfig = yield* LegacyCliConfig;
  const telemetryState = yield* LegacyTelemetryState;
  const output = yield* Output;
  const yes = yield* LegacyYesFlag;
  const tty = yield* Tty;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const emphasize = (text: string) => styleIfTty(tty.stdoutIsTty, "bold", text);
  const warnText = (text: string) => styleIfTty(tty.stdoutIsTty, "yellow", text);

  return yield* Effect.gen(function* () {
    const key = yield* generatePrivateKey(flags.algorithm);
    const configured = yield* loadSigningKeysConfig(cliConfig.workdir);

    if (Option.isNone(configured)) {
      yield* output.raw(`${JSON.stringify(key)}\n`, "stdout");
      const defaultPath = path.join("supabase", "signing_keys.json");
      yield* output.raw(
        `\nTo enable JWT signing keys in your local project:\n1. Save the generated key to ${emphasize(defaultPath)}\n2. Update your ${emphasize(path.join("supabase", "config.toml"))} with the new keys path\n\n[auth]\nsigning_keys_path = "./signing_keys.json"\n\n`,
        "stderr",
      );
      return;
    }

    const nextKeys = flags.append
      ? [...configured.value.existingKeys, key]
      : yield* Effect.gen(function* () {
          const confirmed = yield* confirmOverwrite(
            `Do you want to overwrite the existing ${emphasize(configured.value.displayPath)} file?`,
            yes,
            tty,
            output,
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
      const ignored = yield* isGitIgnored(configured.value.actualPath, cliConfig.workdir);
      if (Option.isSome(ignored) && !ignored.value) {
        yield* output.raw(
          `${warnText("IMPORTANT:")} Add your signing key path to .gitignore to prevent committing to version control.\n`,
          "stderr",
        );
      }
    }
  }).pipe(Effect.ensuring(telemetryState.flush));
});
