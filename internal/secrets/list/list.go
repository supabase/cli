package list

import (
	"context"
	"fmt"
	"sort"
	"strings"

	"github.com/go-errors/errors"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/migration/list"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/api"
)

func Run(ctx context.Context, projectRef string, fsys afero.Fs) error {
	secrets, err := GetSecretDigests(ctx, projectRef)
	if err != nil {
		return err
	}

	table := `|NAME|DIGEST|
|-|-|
`
	for _, secret := range secrets {
		table += fmt.Sprintf("|`%s`|`%s`|\n", strings.ReplaceAll(secret.Name, "|", "\\|"), secret.Value)
	}

	return list.RenderTable(table)
}

func GetSecretDigests(ctx context.Context, projectRef string) ([]api.SecretResponse, error) {
	resp, err := utils.GetSupabase().V1ListAllSecretsWithResponse(ctx, projectRef)
	if err != nil {
		return nil, errors.Errorf("failed to list secrets: %w", err)
	}
	if resp.JSON200 == nil {
		return nil, errors.New("Unexpected error retrieving project secrets: " + string(resp.Body))
	}
	secrets := *resp.JSON200
	sort.Slice(secrets, func(i, j int) bool {
		return secrets[i].Name < secrets[j].Name
	})
	return secrets, nil
}
