package helper

import (
	"fmt"

	"github.com/supabase/cli/pkg/pgtest"
	"github.com/supabase/cli/pkg/vault"
)

func MockVaultSetup(conn *pgtest.MockConn, projectRef string) *pgtest.MockConn {
	var url string
	if len(projectRef) == 0 {
		url = "http://kong:8000/functions/v1"
	} else {
		url = fmt.Sprintf("https://%s.supabase.co/functions/v1", projectRef)
	}
	// Mock vault existence check
	conn.Query(vault.CHECK_VAULT).
		Reply("SELECT 1", []interface{}{1}).
		Query(vault.READ_VAULT_KV, []string{vault.SecretFunctionsUrl}).
		Reply("SELECT 0").
		Query(vault.CREATE_VAULT_KV, url, vault.SecretFunctionsUrl).
		Reply("SELECT 1")
	return conn
}
