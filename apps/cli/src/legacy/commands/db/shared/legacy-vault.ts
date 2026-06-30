import { Effect } from "effect";

import { Output } from "../../../../shared/output/output.service.ts";
import type { LegacyDbExecError } from "../../../shared/legacy-db-connection.errors.ts";
import type { LegacyDbSession } from "../../../shared/legacy-db-connection.service.ts";

/**
 * Vault SQL, verbatim from Go's `pkg/vault/batch.go`. `create_secret(value, name)`
 * and `update_secret(id, value)` argument orders match Go exactly.
 */
const READ_VAULT_KV = "SELECT id, name FROM vault.secrets WHERE name = ANY($1)";
const CREATE_VAULT_KV = "SELECT vault.create_secret($1, $2)";
const UPDATE_VAULT_KV = "SELECT vault.update_secret($1, $2)";

// Go's secret env-reference form (`pkg/config/decode_hooks.go:11` —
// `envPattern = ^env\((.*)\)$`); env() references are never synced to the vault —
// Go's decode hook leaves any `env(...)` value verbatim with an empty SHA256,
// regardless of the inner name's casing. Mirror Go's broad pattern exactly (`.`
// excludes newline in both RE2 and JS without the `s` flag) so a lowercase/oddly
// named reference such as `env(foo)` is skipped, not synced as a literal.
const ENV_REFERENCE_PATTERN = /^env\(.*\)$/u;
// dotenvx-encrypted secrets (Go decrypts before hashing). Decryption is not yet
// ported, so encrypted entries are skipped rather than sent as ciphertext.
const ENCRYPTED_PREFIX = "encrypted:";

/**
 * Extracts the raw `[db.vault]` string entries from a loaded config document.
 * The document is the post-`env()` raw TOML (values are typed `unknown`), so
 * non-string entries are defensively skipped.
 */
export function legacyReadVaultDocument(
  document: Record<string, unknown> | undefined,
): Readonly<Record<string, string>> | undefined {
  const db = document?.["db"];
  const vault =
    typeof db === "object" && db !== null ? (db as Record<string, unknown>)["vault"] : undefined;
  if (typeof vault !== "object" || vault === null) return undefined;
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(vault)) {
    if (typeof value === "string") result[key] = value;
  }
  return result;
}

/**
 * Selects the `[db.vault]` entries Go would sync. Go's secret decode
 * (`pkg/config/secret.go:86-108`) sets a non-empty `SHA256` — the gate
 * `UpsertVaultSecrets` keys on — only for non-empty, non-`env()` values, so those
 * are exactly the syncable ones. Encrypted values are excluded pending the
 * decryption port (documented in SIDE_EFFECTS.md).
 */
export function legacySyncableVaultSecrets(
  vault: Readonly<Record<string, string>> | undefined,
): ReadonlyArray<{ readonly key: string; readonly value: string }> {
  if (vault === undefined) return [];
  const result: Array<{ readonly key: string; readonly value: string }> = [];
  for (const [key, value] of Object.entries(vault)) {
    if (value.length === 0) continue;
    if (ENV_REFERENCE_PATTERN.test(value)) continue;
    if (value.startsWith(ENCRYPTED_PREFIX)) continue;
    result.push({ key, value });
  }
  return result;
}

/**
 * Upserts configured `[db.vault]` secrets into the target database. Mirrors Go's
 * `vault.UpsertVaultSecrets` (`pkg/vault/batch.go:25-60`): no-op when nothing is
 * syncable; otherwise read existing secrets by name, `update_secret` the matches
 * (by id) and `create_secret` the rest. Emits `Updating vault secrets...` to
 * stderr only when there is at least one secret to sync.
 */
export const legacyUpsertVaultSecrets = <E>(
  session: LegacyDbSession,
  vault: Readonly<Record<string, string>> | undefined,
  mapError: (message: string) => E,
): Effect.Effect<void, E, Output> =>
  Effect.gen(function* () {
    const output = yield* Output;
    const secrets = legacySyncableVaultSecrets(vault);
    if (secrets.length === 0) return;
    const toInsert = new Map(secrets.map((s) => [s.key, s.value]));

    yield* output.raw("Updating vault secrets...\n", "stderr");

    const existing = yield* session.query(READ_VAULT_KV, [secrets.map((s) => s.key)]);

    // Go queues every update/create in a single `pgx.Batch` and `SendBatch().Close()`
    // runs it as one implicit transaction (`pkg/vault/batch.go:46-58`), so a later
    // failure leaves Vault entirely unchanged. Mirror that atomicity with an explicit
    // transaction around the write phase (the read above stays outside, as in Go).
    yield* session.exec("BEGIN");
    const writes = Effect.gen(function* () {
      for (const row of existing) {
        const name = String(row["name"]);
        const id = String(row["id"]);
        const value = toInsert.get(name);
        if (value === undefined) continue;
        yield* session.query(UPDATE_VAULT_KV, [id, value]);
        toInsert.delete(name);
      }
      for (const [key, value] of toInsert) {
        yield* session.query(CREATE_VAULT_KV, [value, key]);
      }
      yield* session.exec("COMMIT");
    });
    yield* writes.pipe(Effect.tapError(() => session.exec("ROLLBACK").pipe(Effect.ignore)));
  }).pipe(Effect.mapError((error: LegacyDbExecError) => mapError(error.message)));
