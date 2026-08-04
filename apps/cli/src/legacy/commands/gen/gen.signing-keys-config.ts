import { loadProjectConfig } from "@supabase/config";
import { Effect, FileSystem, Option, Path } from "effect";

/**
 * Shared `[auth].signing_keys_path` config-loading logic for the `gen` command
 * family — used by both `gen signing-key` (`signing-key.handler.ts`, generating
 * or appending a key) and `gen bearer-jwt` (`bearer-jwt.handler.ts`, resolving
 * a key to sign with). Per `apps/cli/CLAUDE.md`'s "hoist before you duplicate"
 * rule: this logic is used by ≥2 commands in the same command family, so it
 * lives at the family root (`legacy/commands/gen/`) rather than being inlined
 * in either sibling.
 *
 * Error TYPES are intentionally NOT shared — each caller passes its own
 * tagged-error constructors (mirroring `sso.saml.ts`'s `readMetadataFile`
 * pattern), so `gen signing-key` and `gen bearer-jwt` keep independent error
 * hierarchies while sharing the actual file-resolution/read/decode logic.
 */

export type StoredSigningKeyJwk = Readonly<Record<string, unknown>>;

interface LegacyGenSigningKeysConfigPaths {
  /** CWD-relative `supabase/config.toml` (or the resolved config file's own display path). */
  readonly configDisplayPath: string;
  /**
   * `[auth].enabled` from the resolved config (default `true`). Go's `Config.Validate`
   * only reads `[auth].signing_keys_path`'s file INSIDE `if c.Auth.Enabled` — callers
   * that must replicate that gate (`gen bearer-jwt`'s `getSigningKey`) branch on this;
   * `gen signing-key` does not (see its own doc comment for why that's intentional).
   */
  readonly authEnabled: boolean;
  /** `Option.some` when `[auth].signing_keys_path` is configured (non-empty). */
  readonly signingKeysPath: Option.Option<{
    readonly actualPath: string;
    readonly displayPath: string;
  }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Resolves `supabase/config.toml`'s display path and `[auth].signing_keys_path`'s
 * actual/display path — no file I/O on the keys path itself (see
 * {@link legacyReadSigningKeysFile} for that). Mirrors Go's `flags.LoadConfig` +
 * `Config.Validate`'s path resolution (`apps/cli-go/pkg/config/config.go:928-930`).
 */
export const legacyResolveSigningKeysConfigPaths = Effect.fnUntraced(function* <E>(
  cwd: string,
  onConfigParseError: (message: string) => E,
) {
  const path = yield* Path.Path;
  const loaded = yield* loadProjectConfig(cwd, { goViperCompat: true }).pipe(
    Effect.catchTag("ProjectConfigParseError", (cause) =>
      Effect.fail(onConfigParseError(`failed to parse ${cause.path}: ${String(cause.cause)}`)),
    ),
  );
  if (loaded === null) {
    return {
      configDisplayPath: path.join("supabase", "config.toml"),
      authEnabled: true,
      signingKeysPath: Option.none(),
    } satisfies LegacyGenSigningKeysConfigPaths;
  }

  // Go displays the CWD-relative `supabase/config.toml` (utils.ConfigPath), never an absolute
  // path. `@supabase/config` always resolves `loaded.path` to an absolute path, so relativize it
  // back against the project root to match Go's output.
  const projectRoot = path.dirname(path.dirname(loaded.path));
  const configDisplayPath = path.relative(projectRoot, loaded.path);
  const authEnabled = loaded.config.auth.enabled;

  const configuredPath = loaded.config.auth.signing_keys_path;
  if (configuredPath === undefined || configuredPath.length === 0) {
    return {
      configDisplayPath,
      authEnabled,
      signingKeysPath: Option.none(),
    } satisfies LegacyGenSigningKeysConfigPaths;
  }

  const resolvedPath = path.isAbsolute(configuredPath)
    ? configuredPath
    : path.join(path.dirname(loaded.path), configuredPath);
  const displayPath = path.isAbsolute(configuredPath)
    ? configuredPath
    : path.relative(projectRoot, resolvedPath);
  return {
    configDisplayPath,
    authEnabled,
    signingKeysPath: Option.some({ actualPath: resolvedPath, displayPath }),
  } satisfies LegacyGenSigningKeysConfigPaths;
});

/**
 * Reads and JSON-decodes a `[auth].signing_keys_path` file at `actualPath` into an array of
 * JWK-shaped records. Mirrors Go's `Config.Validate` read (`config.go:1110-1116`, wrapped
 * `"failed to read signing keys: %w"` / `"failed to decode signing keys: %w"`) — the
 * "expected a JSON array [of objects]" shape check matches this package's own pre-existing
 * `gen signing-key` behavior (not a literal Go error string; Go's decode failures come from
 * `encoding/json`'s own type-mismatch errors, which `readJwkArray`'s two checks approximate).
 */
export const legacyReadSigningKeysFile = Effect.fnUntraced(function* <E1, E2>(
  actualPath: string,
  onReadError: (message: string) => E1,
  onDecodeError: (message: string) => E2,
) {
  const fs = yield* FileSystem.FileSystem;
  const raw = yield* fs
    .readFileString(actualPath)
    .pipe(Effect.mapError((cause) => onReadError(`failed to read signing keys: ${String(cause)}`)));
  const decoded = yield* Effect.try({
    try: () => JSON.parse(raw),
    catch: (cause) => onDecodeError(`failed to decode signing keys: ${String(cause)}`),
  });
  if (!Array.isArray(decoded)) {
    return yield* Effect.fail(
      onDecodeError("failed to decode signing keys: expected a JSON array"),
    );
  }
  for (const item of decoded) {
    if (!isRecord(item)) {
      return yield* Effect.fail(
        onDecodeError("failed to decode signing keys: expected a JSON array of objects"),
      );
    }
  }
  return decoded as ReadonlyArray<StoredSigningKeyJwk>;
});
