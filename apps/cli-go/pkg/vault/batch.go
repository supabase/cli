package vault

import (
	"context"
	"fmt"
	"os"
	"slices"

	"github.com/go-errors/errors"
	"github.com/jackc/pgx/v4"
	"github.com/supabase/cli/pkg/config"
	"github.com/supabase/cli/pkg/pgxv5"
)

const (
	CREATE_VAULT_KV = "SELECT vault.create_secret($1, $2)"
	READ_VAULT_KV   = "SELECT id, name FROM vault.secrets WHERE name = ANY($1)"
	UPDATE_VAULT_KV = "SELECT vault.update_secret($1, $2)"
)

type VaultTable struct {
	Id   string
	Name string
}

// ResolvedSecretNames returns vault secret names from config that would be upserted.
func ResolvedSecretNames(secrets map[string]config.Secret) []string {
	var names []string
	for name, secret := range secrets {
		if len(secret.SHA256) > 0 {
			names = append(names, name)
		}
	}
	slices.Sort(names)
	return names
}

func UpsertVaultSecrets(ctx context.Context, secrets map[string]config.Secret, conn *pgx.Conn) error {
	names := ResolvedSecretNames(secrets)
	if len(names) == 0 {
		return nil
	}
	toInsert := map[string]string{}
	for _, name := range names {
		toInsert[name] = secrets[name].Value
	}
	fmt.Fprintln(os.Stderr, "Updating vault secrets...")
	rows, err := conn.Query(ctx, READ_VAULT_KV, names)
	if err != nil {
		return errors.Errorf("failed to read vault: %w", err)
	}
	toUpdate, err := pgxv5.CollectRows[VaultTable](rows)
	if err != nil {
		return err
	}
	batch := pgx.Batch{}
	for _, r := range toUpdate {
		secret := secrets[r.Name]
		batch.Queue(UPDATE_VAULT_KV, r.Id, secret.Value)
		delete(toInsert, r.Name)
	}
	// Remaining secrets should be created
	for k, v := range toInsert {
		batch.Queue(CREATE_VAULT_KV, v, k)
	}
	if err := conn.SendBatch(ctx, &batch).Close(); err != nil {
		return errors.Errorf("failed to update vault: %w", err)
	}
	return nil
}
