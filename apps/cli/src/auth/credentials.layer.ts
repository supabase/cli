import { Effect, FileSystem, Layer, Option, Path, Redacted } from "effect";

import { CliConfig } from "../config/cli-config.service.ts";
import { Credentials } from "./credentials.service.ts";

const SERVICE = "Supabase CLI";
const ACCOUNT = "access-token";
const LEGACY_ACCOUNT = "supabase";

/**
 * credentialsLayer - Token persistence policy for the CLI.
 *
 * The layer prefers keyring-backed storage when available, while preserving a
 * filesystem fallback for no-keyring environments and older installs.
 */
const makeCredentials = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cliConfig = yield* CliConfig;
  const fallbackDir = cliConfig.supabaseHome;
  const fallbackPath = path.join(fallbackDir, "access-token");

  const keyringModule =
    Option.isSome(cliConfig.noKeyring) && cliConfig.noKeyring.value === "1"
      ? Option.none<typeof import("@napi-rs/keyring")>()
      : yield* Effect.tryPromise(() => import("@napi-rs/keyring")).pipe(Effect.option);

  return Credentials.of({
    // Read current storage first, then fall back to legacy account and finally the filesystem.
    getAccessToken: Effect.gen(function* () {
      if (Option.isSome(keyringModule)) {
        try {
          const entry = new keyringModule.value.Entry(SERVICE, ACCOUNT);
          const token = entry.getPassword();
          if (token) return Option.some(Redacted.make(token));
        } catch {
          /* fall through */
        }

        try {
          const entry = new keyringModule.value.Entry(SERVICE, LEGACY_ACCOUNT);
          const token = entry.getPassword();
          if (token) return Option.some(Redacted.make(token));
        } catch {
          /* fall through */
        }
      }

      const exists = yield* fs.exists(fallbackPath);
      if (exists) {
        const content = yield* fs.readFileString(fallbackPath);
        const trimmed = content.trim();
        if (trimmed) return Option.some(Redacted.make(trimmed));
      }

      return Option.none();
    }).pipe(Effect.orElseSucceed(() => Option.none())),

    // Writes follow the same policy: keyring when possible, filesystem when necessary.
    saveAccessToken: (token: string | Redacted.Redacted<string>) =>
      Effect.gen(function* () {
        const plainToken = typeof token === "string" ? token : Redacted.value(token);
        if (Option.isSome(keyringModule)) {
          try {
            const entry = new keyringModule.value.Entry(SERVICE, ACCOUNT);
            entry.setPassword(plainToken);
            return;
          } catch {
            /* fall through */
          }
        }

        yield* fs.makeDirectory(fallbackDir, { recursive: true, mode: 0o700 });
        yield* fs.writeFileString(fallbackPath, plainToken, { mode: 0o600 });
      }).pipe(Effect.orDie),
  });
});

export const credentialsLayer = Layer.effect(Credentials, makeCredentials);
