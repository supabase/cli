package list

import (
	"context"
	"fmt"
	"time"

	"github.com/go-errors/errors"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/migration/list"
	"github.com/supabase/cli/internal/utils"
)

func Run(ctx context.Context, projectRef string, fsys afero.Fs) error {
	resp, err := utils.GetSupabase().GetFunctionsWithResponse(ctx, projectRef)
	if err != nil {
		return errors.Errorf("failed to list functions: %w", err)
	}

	if resp.JSON200 == nil {
		return errors.New("Unexpected error retrieving functions: " + string(resp.Body))
	}

	table := `|ID|NAME|SLUG|STATUS|VERSION|UPDATED_AT (UTC)|
|-|-|-|-|-|-|
`
	for _, function := range *resp.JSON200 {
		t := time.UnixMilli(int64(function.UpdatedAt))
		table += fmt.Sprintf(
			"|`%s`|`%s`|`%s`|`%s`|`%d`|`%s`|\n",
			function.Id,
			function.Name,
			function.Slug,
			function.Status,
			uint64(function.Version),
			t.UTC().Format("2006-01-02 15:04:05"),
		)
	}

	return list.RenderTable(table)
}
