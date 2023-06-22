package apiKeys

import (
	"context"
	"fmt"
	"strings"

	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/migration/list"
	"github.com/supabase/cli/internal/utils"
)

func Run(ctx context.Context, projectRef string, fsys afero.Fs) error {
	resp, err := utils.GetSupabase().GetProjectApiKeysWithResponse(ctx, projectRef)
	if err != nil {
		return utils.Red(err.Error())
	}

	if resp.JSON200 == nil {
		return utils.Red("Unexpected error retrieving project api-keys: " + string(resp.Body))
	}

	table := `|NAME|KEY VALUE|
|-|-|
`
	for _, api_key := range *resp.JSON200 {
		table += fmt.Sprintf("|`%s`|`%x`|\n", strings.ReplaceAll(api_key.Name, "|", "\\|"), api_key.ApiKey)
	}

	return list.RenderTable(table)
}
