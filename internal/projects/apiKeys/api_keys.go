package apiKeys

import (
	"context"
	"fmt"
	"os"
	"strings"

	"github.com/go-errors/errors"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/migration/list"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/api"
)

func Run(ctx context.Context, projectRef string, fsys afero.Fs) error {
	keys, err := RunGetApiKeys(ctx, projectRef)
	if err != nil {
		return err
	}

	if utils.OutputFormat.Value == utils.OutputPretty {
		table := `|NAME|KEY VALUE|
|-|-|
`
		for _, entry := range keys {
			table += fmt.Sprintf("|`%s`|`%s`|\n", strings.ReplaceAll(entry.Name, "|", "\\|"), entry.ApiKey)
		}

		return list.RenderTable(table)
	}

	return utils.EncodeOutput(utils.OutputFormat.Value, os.Stdout, keys)
}

func RunGetApiKeys(ctx context.Context, projectRef string) ([]api.ApiKeyResponse, error) {
	resp, err := utils.GetSupabase().V1GetProjectApiKeysWithResponse(ctx, projectRef, &api.V1GetProjectApiKeysParams{})
	if err != nil {
		return nil, errors.Errorf("failed to get api keys: %w", err)
	}
	if resp.JSON200 == nil {
		return nil, errors.New("Unexpected error retrieving project api-keys: " + string(resp.Body))
	}
	return *resp.JSON200, nil
}
