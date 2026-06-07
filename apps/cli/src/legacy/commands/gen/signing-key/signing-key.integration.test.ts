import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Layer, Option } from "effect";

import { mockOutput, mockTty } from "../../../../../tests/helpers/mocks.ts";
import {
  buildLegacyTestRuntime,
  mockLegacyCliConfig,
  mockLegacyPlatformApi,
  mockLegacyTelemetryStateTracked,
  useLegacyTempWorkdir,
} from "../../../../../tests/helpers/legacy-mocks.ts";
import { LegacyYesFlag } from "../../../../shared/legacy/global-flags.ts";
import { legacyGenSigningKey } from "./signing-key.handler.ts";

const tempRoot = useLegacyTempWorkdir("supabase-gen-signing-key-int-");

interface SetupOptions {
  readonly stdinIsTty?: boolean;
  readonly yes?: boolean;
  readonly promptConfirmResponses?: ReadonlyArray<boolean>;
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
  const layer = Layer.mergeAll(
    buildLegacyTestRuntime({ out, api, cliConfig, tty }),
    Layer.succeed(LegacyYesFlag, options.yes ?? false),
  );
  return { layer, out };
}

function setupTracked(options: SetupOptions = {}) {
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
  const telemetry = mockLegacyTelemetryStateTracked();
  const layer = Layer.mergeAll(
    buildLegacyTestRuntime({ out, api, cliConfig, tty, telemetry: telemetry.layer }),
    Layer.succeed(LegacyYesFlag, options.yes ?? false),
  );
  return { layer, out, telemetry };
}

async function writeConfig(contents: string) {
  await mkdir(join(tempRoot.current, "supabase"), { recursive: true });
  await writeFile(join(tempRoot.current, "supabase", "config.toml"), contents);
}

async function initGitRepo(gitignore = "") {
  const process = Bun.spawn(["git", "init"], {
    cwd: tempRoot.current,
    stdout: "ignore",
    stderr: "ignore",
  });
  const exitCode = await process.exited;
  if (exitCode !== 0) {
    throw new Error(`git init failed with exit code ${exitCode}`);
  }
  if (gitignore.length > 0) {
    await writeFile(join(tempRoot.current, ".gitignore"), gitignore);
  }
}

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
    const { layer, out } = setup();
    return Effect.gen(function* () {
      yield* Effect.tryPromise(() =>
        writeConfig('[auth]\nsigning_keys_path = "./signing_keys.json"\n'),
      );
      yield* Effect.tryPromise(() => initGitRepo());
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
      const { layer, out } = setup();
      return Effect.gen(function* () {
        yield* Effect.tryPromise(() =>
          writeConfig('[auth]\nsigning_keys_path = "./signing_keys.json"\n'),
        );
        yield* Effect.tryPromise(() => initGitRepo("supabase/*.json\n"));
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
    const { layer, telemetry } = setupTracked();
    return Effect.gen(function* () {
      yield* legacyGenSigningKey({ algorithm: "ES256", append: false });
      expect(telemetry.flushed).toBe(true);
    }).pipe(Effect.provide(layer));
  });
});
