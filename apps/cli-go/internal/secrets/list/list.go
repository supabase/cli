package list

import (
	"context"
	"fmt"
	"os"
	"sort"
	"strings"

	"github.com/go-errors/errors"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/api"
)

func Run(ctx context.Context, projectRef string, fsys afero.Fs) error {
	secrets, err := GetSecretDigests(ctx, projectRef)
	if err != nil {
		return err
	}

	switch utils.OutputFormat.Value {
	case utils.OutputPretty:
		table := `|NAME|DIGEST|
|-|-|
`
		for _, secret := range secrets {
			table += fmt.Sprintf("|`%s`|`%s`|\n", strings.ReplaceAll(secret.Name, "|", "\\|"), secret.Value)
		}
		return utils.RenderTable(table)
	case utils.OutputToml:
		return utils.EncodeOutput(utils.OutputFormat.Value, os.Stdout, struct {
			Secrets []api.SecretResponse `toml:"secrets"`
		}{
			Secrets: secrets,
		})
	case utils.OutputEnv:
		return errors.New(utils.ErrEnvNotSupported)
	}

	return utils.EncodeOutput(utils.OutputFormat.Value, os.Stdout, secrets)
}

func GetSecretDigests(ctx context.Context, projectRef string) ([]api.SecretResponse, error) {
	resp, err := utils.GetSupabase().V1ListAllSecretsWithResponse(ctx, projectRef)
	if err != nil {
		return nil, errors.Errorf("failed to list secrets: %w", err)
	} else if resp.JSON200 == nil {
		return nil, errors.Errorf("unexpected list secrets status %d: %s", resp.StatusCode(), string(resp.Body))
	}
	secrets := *resp.JSON200
	sort.Slice(secrets, func(i, j int) bool {
		return secrets[i].Name < secrets[j].Name
	})
	return secrets, nil
}
