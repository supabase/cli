package vault

import (
	"context"
	"fmt"
	"os"

	"github.com/go-errors/errors"
	"github.com/jackc/pgx/v4"
	"github.com/supabase/cli/pkg/config"
	"github.com/supabase/cli/pkg/pgxv5"
)

const (
	CREATE_VAULT_KV = "SELECT vault.create_secret($1, $2)"
	READ_VAULT_KV   = "SELECT id, name FROM vault.secrets WHERE name = ANY($1)"
	UPDATE_VAULT_KV = "SELECT vault.update_secret($1, $2)"
	CHECK_VAULT     = "SELECT 1 FROM pg_namespace WHERE nspname = 'vault'"

	SecretFunctionsUrl   = "supabase_functions_url"
	SecretServiceRoleKey = "supabase_service_role_key"
)

type VaultTable struct {
	Id   string
	Name string
}

func UpsertVaultSecrets(ctx context.Context, secrets map[string]config.Secret, conn *pgx.Conn) error {
	var keys []string
	toInsert := map[string]string{}
	for k, v := range secrets {
		if len(v.SHA256) > 0 {
			keys = append(keys, k)
			toInsert[k] = v.Value
		}
	}
	if len(keys) == 0 {
		return nil
	}
	var exists int
	if err := conn.QueryRow(ctx, CHECK_VAULT).Scan(&exists); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		return errors.Errorf("failed to check vault schema: %w", err)
	}
	fmt.Fprintln(os.Stderr, "Updating vault secrets...")
	rows, err := conn.Query(ctx, READ_VAULT_KV, keys)
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

func WithEdgeFunctionSecrets(secrets map[string]config.Secret, projectRef, serviceRoleKey string) map[string]config.Secret {
	result := make(map[string]config.Secret, len(secrets)+2)
	for k, v := range secrets {
		result[k] = v
	}
	if _, exists := result[SecretFunctionsUrl]; !exists {
		var url string
		if len(projectRef) == 0 {
			url = "http://kong:8000/functions/v1"
		} else {
			url = fmt.Sprintf("https://%s.supabase.co/functions/v1", projectRef)
		}
		result[SecretFunctionsUrl] = config.Secret{
			Value:  url,
			SHA256: "default",
		}
	}
	if _, exists := result[SecretServiceRoleKey]; !exists && len(projectRef) == 0 && len(serviceRoleKey) > 0 {
		result[SecretServiceRoleKey] = config.Secret{
			Value:  serviceRoleKey,
			SHA256: "default",
		}
	}
	return result
}
