package list

import (
	"context"
	"fmt"
	"strings"

	"github.com/go-errors/errors"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/migration/list"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/api"
)

func Run(ctx context.Context, fsys afero.Fs) error {
	ref, err := utils.LoadProjectRef(fsys)
	if err != nil {
		return err
	}
	resp, err := utils.GetSupabase().ListSnippetsWithResponse(ctx, &api.ListSnippetsParams{ProjectRef: &ref})
	if err != nil {
		return errors.Errorf("failed to list snippets: %w", err)
	}

	if resp.JSON200 == nil {
		return errors.New("Unexpected error listing SQL snippets: " + string(resp.Body))
	}

	table := `|ID|NAME|VISIBILITY|OWNER|CREATED AT (UTC)|UPDATED AT (UTC)|
|-|-|-|-|-|-|
`
	for _, snippet := range resp.JSON200.Data {
		table += fmt.Sprintf(
			"|`%s`|`%s`|`%s`|`%s`|`%s`|`%s`|\n",
			snippet.Id,
			strings.ReplaceAll(snippet.Name, "|", "\\|"),
			strings.ReplaceAll(string(snippet.Visibility), "|", "\\|"),
			strings.ReplaceAll(snippet.Owner.Username, "|", "\\|"),
			utils.FormatTimestamp(snippet.InsertedAt),
			utils.FormatTimestamp(snippet.UpdatedAt),
		)
	}

	return list.RenderTable(table)
}
