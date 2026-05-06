package list

import (
	"context"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/go-errors/errors"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/api"
)

func Run(ctx context.Context, projectRef string, fsys afero.Fs) error {
	resp, err := utils.GetSupabase().V1ListAllFunctionsWithResponse(ctx, projectRef)
	if err != nil {
		return errors.Errorf("failed to list functions: %w", err)
	} else if resp.JSON200 == nil {
		return errors.Errorf("unexpected list functions status %d: %s", resp.StatusCode(), string(resp.Body))
	}

	switch utils.OutputFormat.Value {
	case utils.OutputPretty:
		var table strings.Builder
		table.WriteString(`|ID|NAME|SLUG|STATUS|VERSION|UPDATED_AT (UTC)|
|-|-|-|-|-|-|
`)
		for _, function := range *resp.JSON200 {
			t := time.UnixMilli(function.UpdatedAt)
			fmt.Fprintf(&table, "|`%s`|`%s`|`%s`|`%s`|`%d`|`%s`|\n",
				function.Id,
				function.Name,
				function.Slug,
				function.Status,
				function.Version,
				t.UTC().Format("2006-01-02 15:04:05"),
			)
		}
		return utils.RenderTable(table.String())
	case utils.OutputToml:
		return utils.EncodeOutput(utils.OutputFormat.Value, os.Stdout, struct {
			Functions []api.FunctionResponse `toml:"functions"`
		}{
			Functions: *resp.JSON200,
		})
	case utils.OutputEnv:
		return errors.New(utils.ErrEnvNotSupported)
	}

	return utils.EncodeOutput(utils.OutputFormat.Value, os.Stdout, *resp.JSON200)
}
