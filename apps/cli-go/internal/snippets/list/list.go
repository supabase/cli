package list

import (
	"context"
	"fmt"
	"os"
	"strings"

	"github.com/go-errors/errors"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/flags"
	"github.com/supabase/cli/pkg/api"
)

func Run(ctx context.Context, fsys afero.Fs) error {
	opts := api.V1ListAllSnippetsParams{ProjectRef: &flags.ProjectRef}
	resp, err := utils.GetSupabase().V1ListAllSnippetsWithResponse(ctx, &opts)
	if err != nil {
		return errors.Errorf("failed to list snippets: %w", err)
	} else if resp.JSON200 == nil {
		return errors.Errorf("unexpected list snippets status %d: %s", resp.StatusCode(), string(resp.Body))
	}

	switch utils.OutputFormat.Value {
	case utils.OutputPretty:
		var table strings.Builder
		table.WriteString(`|ID|NAME|VISIBILITY|OWNER|CREATED AT (UTC)|UPDATED AT (UTC)|
|-|-|-|-|-|-|
`)
		for _, snippet := range resp.JSON200.Data {
			fmt.Fprintf(&table, "|`%s`|`%s`|`%s`|`%s`|`%s`|`%s`|\n",
				snippet.Id,
				strings.ReplaceAll(snippet.Name, "|", "\\|"),
				strings.ReplaceAll(string(snippet.Visibility), "|", "\\|"),
				strings.ReplaceAll(snippet.Owner.Username, "|", "\\|"),
				utils.FormatTimestamp(snippet.InsertedAt),
				utils.FormatTimestamp(snippet.UpdatedAt),
			)
		}
		return utils.RenderTable(table.String())
	case utils.OutputEnv:
		return errors.New(utils.ErrEnvNotSupported)
	}

	return utils.EncodeOutput(utils.OutputFormat.Value, os.Stdout, *resp.JSON200)
}
