package apiKeys

import (
	"context"
	"fmt"
	"strings"

	"github.com/go-errors/errors"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/migration/list"
	"github.com/supabase/cli/internal/utils"
)

func Run(ctx context.Context, projectRef string, fsys afero.Fs) error {
	resp, err := utils.GetSupabase().GetProjectApiKeysWithResponse(ctx, projectRef)
	if err != nil {
		return errors.Errorf("failed to get api keys: %w", err)
	}

	if resp.JSON200 == nil {
		return errors.New("Unexpected error retrieving project api-keys: " + string(resp.Body))
	}

	table := `|NAME|KEY VALUE|
|-|-|
`
	for _, entry := range *resp.JSON200 {
		table += fmt.Sprintf("|`%s`|`%s`|\n", strings.ReplaceAll(entry.Name, "|", "\\|"), entry.ApiKey)
	}

	return list.RenderTable(table)
}
