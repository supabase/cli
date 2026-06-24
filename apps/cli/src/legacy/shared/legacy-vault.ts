import { Data, Effect } from "effect";

import { Output } from "../../shared/output/output.service.ts";
import type { LegacyDbSession } from "./legacy-db-connection.service.ts";

/** Reading or updating `vault.secrets` failed (Go's `UpsertVaultSecrets` errors). */
export class LegacyMigrationVaultError extends Data.TaggedError("LegacyMigrationVaultError")<{
  readonly message: string;
}> {}

/** A resolved `[db.vault]` secret. `resolved` mirrors Go's `len(SHA256) > 0` gate. */
export interface LegacyVaultSecret {
  readonly name: string;
  readonly value: string;
  readonly resolved: boolean;
}

const READ_VAULT_KV = "SELECT id, name FROM vault.secrets WHERE name = ANY($1)";
const UPDATE_VAULT_KV = "SELECT vault.update_secret($1, $2)";
const CREATE_VAULT_KV = "SELECT vault.create_secret($1, $2)";

/**
 * Upserts `[db.vault]` secrets into `vault.secrets`. Port of Go's
 * `vault.UpsertVaultSecrets` (`pkg/vault/batch.go:25`): only resolved secrets
 * (Go gates on a non-empty SHA256) are processed; existing names are updated by
 * id, the rest are created. No resolved secrets → no-op (no DB round-trip).
 */
export const legacyUpsertVaultSecrets = (
  session: LegacyDbSession,
  secrets: ReadonlyArray<LegacyVaultSecret>,
) =>
  Effect.gen(function* () {
    const output = yield* Output;
    const resolved = secrets.filter((secret) => secret.resolved);
    if (resolved.length === 0) return;

    yield* output.raw("Updating vault secrets...\n", "stderr");

    const existing = yield* session
      .query(READ_VAULT_KV, [resolved.map((secret) => secret.name)])
      .pipe(
        Effect.mapError(
          (cause) =>
            new LegacyMigrationVaultError({ message: `failed to read vault: ${cause.message}` }),
        ),
      );
    const existingByName = new Map(
      existing.map((row) => [String(row["name"]), String(row["id"])] as const),
    );

    // One transaction, mirroring Go's implicitly-transactional `SendBatch`.
    const batch = Effect.gen(function* () {
      yield* session.exec("BEGIN");
      for (const secret of resolved) {
        const id = existingByName.get(secret.name);
        if (id !== undefined) {
          yield* session.query(UPDATE_VAULT_KV, [id, secret.value]);
        } else {
          yield* session.query(CREATE_VAULT_KV, [secret.value, secret.name]);
        }
      }
      yield* session.exec("COMMIT");
    });
    yield* batch.pipe(
      Effect.tapError(() => session.exec("ROLLBACK").pipe(Effect.ignore)),
      Effect.mapError(
        (cause) =>
          new LegacyMigrationVaultError({ message: `failed to update vault: ${cause.message}` }),
      ),
    );
  });
