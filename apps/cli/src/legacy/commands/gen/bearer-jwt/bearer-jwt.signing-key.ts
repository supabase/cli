import { Effect, Option } from "effect";
import {
  legacyReadSigningKeysFile,
  legacyResolveSigningKeysConfigPaths,
} from "../gen.signing-keys-config.ts";
import { LEGACY_DEFAULT_SIGNING_KEY, type LegacyJwk } from "../../../shared/legacy-go-jwt.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import { Stdin } from "../../../../shared/runtime/stdin.service.ts";
import { Tty } from "../../../../shared/runtime/tty.service.ts";
import { legacyGoJsonKindName } from "./bearer-jwt.claims.ts";
import {
  legacyBearerJwtErrorMessage,
  LegacyGenBearerJwtConfigParseError,
  LegacyGenBearerJwtDecodeError,
  LegacyGenBearerJwtKeyNotFoundError,
  LegacyGenBearerJwtKeyParseError,
  LegacyGenBearerJwtReadError,
} from "./bearer-jwt.errors.ts";

/** Go's `Console.ReadLine` timeouts (`apps/cli-go/internal/utils/console.go:35-36`). */
const GO_CONSOLE_TTY_TIMEOUT_MILLIS = 10 * 60 * 1000;
const GO_CONSOLE_NON_TTY_TIMEOUT_MILLIS = 100;

/**
 * Port of Go's `Console.PromptText` (`apps/cli-go/internal/utils/console.go:96-107`):
 * writes `label` to stderr with NO trailing newline, reads one line bounded by a
 * TTY-aware timeout, and — only on a non-TTY — echoes the (trimmed) input back to
 * stderr. On a real TTY the terminal's own line-editing already echoes what the user
 * types, so no explicit echo is written there, matching Go exactly. Used for BOTH of
 * `getSigningKey`'s text prompts (`bearerjwt.go:38`, `:54`) — the branch between them
 * is purely which label/fallback the caller applies to the returned string, not how
 * the read itself behaves.
 */
const legacyConsolePromptText = Effect.fnUntraced(function* (label: string) {
  const output = yield* Output;
  const tty = yield* Tty;
  const stdin = yield* Stdin;
  yield* output.raw(label, "stderr");
  const line = yield* stdin.readLine(
    tty.stdinIsTty ? GO_CONSOLE_TTY_TIMEOUT_MILLIS : GO_CONSOLE_NON_TTY_TIMEOUT_MILLIS,
  );
  const input = Option.getOrElse(line, () => "");
  if (!tty.stdinIsTty) {
    yield* output.raw(`${input}\n`, "stderr");
  }
  return input;
});

function readOptionalString(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field];
  return typeof value === "string" ? value : undefined;
}

function readOptionalStringArray(
  record: Record<string, unknown>,
  field: string,
): ReadonlyArray<string> | undefined {
  const value = record[field];
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? (value as ReadonlyArray<string>)
    : undefined;
}

/**
 * Narrows an untrusted JSON record (a `signing_keys_path` file entry, or a pasted
 * stdin JWK) into `LegacyJwk`'s shape — every field Go's own `config.JWK` struct
 * would leave at its zero value (`""`/absent) when missing from the JSON decodes the
 * same way here. Every downstream consumer in this file works with the resulting
 * typed `LegacyJwk`, not the raw untrusted record, so key/kid/alg lookups stay
 * type-checked instead of re-guarding `Record<string, unknown>` at every call site.
 */
function normalizeStoredJwk(record: Record<string, unknown>): LegacyJwk {
  const keyOps = readOptionalStringArray(record, "key_ops");
  return {
    kty: readOptionalString(record, "kty") ?? "",
    kid: readOptionalString(record, "kid"),
    use: readOptionalString(record, "use"),
    key_ops: keyOps !== undefined ? [...keyOps] : undefined,
    alg: readOptionalString(record, "alg"),
    ext: typeof record["ext"] === "boolean" ? record["ext"] : undefined,
    n: readOptionalString(record, "n"),
    e: readOptionalString(record, "e"),
    d: readOptionalString(record, "d"),
    p: readOptionalString(record, "p"),
    q: readOptionalString(record, "q"),
    dp: readOptionalString(record, "dp"),
    dq: readOptionalString(record, "dq"),
    qi: readOptionalString(record, "qi"),
    crv: readOptionalString(record, "crv"),
    x: readOptionalString(record, "x"),
    y: readOptionalString(record, "y"),
  };
}

/**
 * Go's `getSigningKey` Branch A (`bearerjwt.go:37-51`, reached when
 * `[auth].signing_keys_path` is NOT configured): prompt for a raw JWK, falling back to
 * the built-in default ES256 dev key on a blank answer.
 */
const resolveSigningKeyFromStdinJwk = Effect.fnUntraced(function* () {
  const input = yield* legacyConsolePromptText(
    "Enter your signing key in JWK format (or leave blank to use local default): ",
  );
  if (input.length === 0) {
    return LEGACY_DEFAULT_SIGNING_KEY;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch (cause) {
    return yield* Effect.fail(
      new LegacyGenBearerJwtKeyParseError({
        message: `failed to parse JWK: ${legacyBearerJwtErrorMessage(cause)}`,
      }),
    );
  }
  // A JSON `null` answer is treated the same as blank (no-op / use the default) —
  // matching `legacyMergeBearerJwtPayload`'s own null-is-a-no-op judgment call for
  // this un-tested-by-Go edge case; see that module's doc comment.
  if (parsed === null) {
    return LEGACY_DEFAULT_SIGNING_KEY;
  }
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    return yield* Effect.fail(
      new LegacyGenBearerJwtKeyParseError({
        message: `failed to parse JWK: json: cannot unmarshal ${legacyGoJsonKindName(parsed)} into Go value of type config.JWK`,
      }),
    );
  }
  return normalizeStoredJwk(parsed as Record<string, unknown>);
});

/**
 * Go's `getSigningKey` Branches B/C (`bearerjwt.go:52-83`, reached when
 * `[auth].signing_keys_path` IS configured): non-TTY prompts for a kid by exact
 * string match (falling back to the first key on a blank answer); a real TTY
 * presents an interactive picker instead (`output.promptSelect`, the same
 * `@clack/prompts`-backed pattern `legacy-project-ref.layer.ts` already uses for
 * Go's bubbletea `PromptChoice` — the rendered ANSI never byte-matches Go's TUI
 * either way, so this codebase's established precedent is to match only the
 * observable stderr line Go itself prints after a choice, "Selected key ID: <kid>").
 */
const resolveSigningKeyFromConfigured = Effect.fnUntraced(function* (
  availableKeys: ReadonlyArray<LegacyJwk>,
) {
  const tty = yield* Tty;

  if (!tty.stdinIsTty) {
    const kid = yield* legacyConsolePromptText(
      "Enter the kid of your signing key (or leave blank to use the first one): ",
    );
    // Go's loop checks every key for an EXACT `KeyID` match BEFORE the blank-input
    // fallback (`bearerjwt.go:59-66`) — so a key whose own `kid` is literally `""`
    // still matches a blank answer here, ahead of "return the first key".
    const found = availableKeys.find((key) => (key.kid ?? "") === kid);
    if (found !== undefined) {
      return found;
    }
    if (kid.length === 0 && availableKeys.length > 0) {
      return availableKeys[0]!;
    }
    return yield* Effect.fail(
      new LegacyGenBearerJwtKeyNotFoundError({ message: `signing key not found: ${kid}` }),
    );
  }

  const output = yield* Output;
  const options = availableKeys.map((key, index) => ({
    value: String(index),
    label: key.kid ?? "",
    hint: `${key.alg ?? ""} (${(key.key_ops ?? []).join(",")})`,
  }));
  const chosen = yield* output.promptSelect("Select a signing key:", options);
  const chosenKey = availableKeys[Number(chosen)]!;
  // Go: `fmt.Fprintln(os.Stderr, "Selected key ID:", choice.Summary)` (`bearerjwt.go:82`).
  yield* output.info(`Selected key ID: ${chosenKey.kid ?? ""}`);
  return chosenKey;
});

/**
 * Go's `getSigningKey` (`apps/cli-go/internal/gen/bearerjwt/bearerjwt.go:35-84`), fully
 * assembled: resolves `[auth].signing_keys_path`'s config, then dispatches to Branch
 * A (unconfigured) or Branches B/C (configured, non-TTY/TTY).
 *
 * Reproduces the verified `[auth].enabled = false` quirk: Go's `Config.Validate` only
 * reads the `signing_keys_path` FILE inside `if c.Auth.Enabled` (`config.go:1087`), but
 * `getSigningKey` only checks whether the PATH STRING is configured
 * (`len(SigningKeysPath) == 0`) — independent of `auth.enabled`. So when auth is
 * disabled and a path IS configured, the kid-prompt branch still runs, but the actual
 * available keys stay the built-in default (the file is never read) — a real user
 * hitting this combination sees a misleading kid prompt they can never satisfy with
 * their own file's kids. `gen signing-key`'s OWN sibling resolver deliberately does
 * NOT replicate this gate (see `gen.signing-keys-config.ts`'s doc comment) — it reads
 * unconditionally, matching that command's own existing, unrelated Go source.
 */
export const legacyResolveBearerJwtSigningKey = Effect.fnUntraced(function* (workdir: string) {
  const paths = yield* legacyResolveSigningKeysConfigPaths(
    workdir,
    (message) => new LegacyGenBearerJwtConfigParseError({ message }),
  );

  if (Option.isNone(paths.signingKeysPath)) {
    return yield* resolveSigningKeyFromStdinJwk();
  }

  const availableKeys: ReadonlyArray<LegacyJwk> = paths.authEnabled
    ? (yield* legacyReadSigningKeysFile(
        paths.signingKeysPath.value.actualPath,
        (message) => new LegacyGenBearerJwtReadError({ message }),
        (message) => new LegacyGenBearerJwtDecodeError({ message }),
      )).map(normalizeStoredJwk)
    : [LEGACY_DEFAULT_SIGNING_KEY];

  return yield* resolveSigningKeyFromConfigured(availableKeys);
});
