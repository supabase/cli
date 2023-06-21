package apiKeys

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/charmbracelet/glamour"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
)

func Run(ctx context.Context, projectRef string, fsys afero.Fs) error {
	// 1. Sanity checks.
	// 2. Print secrets.
	{
		resp, err := utils.GetSupabase().GetProjectApiKeysWithResponse(ctx, projectRef)
		if err != nil {
			return err
		}

		if resp.JSON200 == nil {
			return errors.New("Unexpected error retrieving project api-keys: " + string(resp.Body))
		}

		table := `|NAME|KEY VALUE|
|-|-|
`
		for _, api_key := range *resp.JSON200 {
			table += fmt.Sprintf("|`%s`|`%x`|\n", strings.ReplaceAll(api_key.Name, "|", "\\|"), api_key.ApiKey)
		}

		r, err := glamour.NewTermRenderer(
			glamour.WithAutoStyle(),
			glamour.WithWordWrap(500),
		)
		if err != nil {
			return err
		}
		out, err := r.Render(table)
		if err != nil {
			return err
		}
		fmt.Print(out)
	}

	return nil
}
