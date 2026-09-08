import { Data, Effect } from "effect";

import { Output } from "../shared/output/output.service.ts";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../shared/telemetry/error-actionability.ts";
import type { DbSession } from "./db-connection.service.ts";

/** Reading or updating `vault.secrets` failed (`UpsertVaultSecrets` errors). */
export class MigrationVaultError extends Data.TaggedError("MigrationVaultError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.dbFinding;
  }
}

/** A resolved `[db.vault]` secret. `resolved` mirrors `len(SHA256) > 0` gate. */
export interface VaultSecret {
  readonly name: string;
  readonly value: string;
  readonly resolved: boolean;
}

// Exported for the shadow baseline cache's embedded-SQL digest (`shadow-cache.ts`), which must
// re-key whenever the SQL this module bakes into a baseline changes across CLI releases.
export const READ_VAULT_KV = "SELECT id, name FROM vault.secrets WHERE name = ANY($1)";
export const UPDATE_VAULT_KV = "SELECT vault.update_secret($1, $2)";
export const CREATE_VAULT_KV = "SELECT vault.create_secret($1, $2)";

/**
 * Upserts `[db.vault]` secrets into `vault.secrets`. Port of Go's
 * `vault.UpsertVaultSecrets`: only resolved secrets
 * (Go gates on a non-empty SHA256) are processed; existing names are updated by
 * id, the rest are created. No resolved secrets → no-op (no DB round-trip).
 */
export const upsertVaultSecrets = (session: DbSession, secrets: ReadonlyArray<VaultSecret>) =>
  Effect.gen(function* () {
    const output = yield* Output;
    const resolved = secrets.filter((secret) => secret.resolved);
    if (resolved.length === 0) return;

    yield* output.raw("Updating vault secrets...\n", "stderr");

    const existing = yield* session
      .query(READ_VAULT_KV, [resolved.map((secret) => secret.name)])
      .pipe(
        Effect.mapError(
          (cause) => new MigrationVaultError({ message: `failed to read vault: ${cause.message}` }),
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
        (cause) => new MigrationVaultError({ message: `failed to update vault: ${cause.message}` }),
      ),
    );
  });
