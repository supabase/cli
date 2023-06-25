package list

import (
	"context"
	"errors"
	"fmt"

	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/migration/list"
	"github.com/supabase/cli/internal/utils"
)

func Run(ctx context.Context, projectRef string, fsys afero.Fs) error {
	resp, err := utils.GetSupabase().GetFunctionsWithResponse(ctx, projectRef)
	if err != nil {
		return err
	}

	if resp.JSON200 == nil {
		return errors.New("Unexpected error retrieving functions: " + string(resp.Body))
	}

	table := `|ID|NAME|SLUG|UPDATED_AT|VERSION|STATUS|
|-|-|-|-|-|-|
`
	for _, function := range *resp.JSON200 {
		table += fmt.Sprintf("|`%s`|`%s`|`%s`|`%f`|`%f`|`%s`|\n", function.Id, function.Name, function.Slug, function.UpdatedAt, function.Version, function.Status)
	}

	return list.RenderTable(table)
}
