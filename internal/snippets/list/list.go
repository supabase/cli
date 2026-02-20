package list

import (
	"context"
	"fmt"
	"os"
	"strconv"
	"strings"

	"github.com/go-errors/errors"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/flags"
	"github.com/supabase/cli/pkg/api"
)

const defaultLimit = 10

func Run(ctx context.Context, fsys afero.Fs) error {
	currentCursor := ""
	var allResponses []*api.SnippetList

	for {
		limitStr := strconv.Itoa(defaultLimit)

		opts := api.V1ListAllSnippetsParams{
			ProjectRef: &flags.ProjectRef,
			Limit:      &limitStr,
		}

		if currentCursor != "" {
			opts.Cursor = &currentCursor
		}

		resp, err := utils.GetSupabase().V1ListAllSnippetsWithResponse(ctx, &opts)
		if err != nil {
			return errors.Errorf("failed to list snippets: %w", err)
		} else if resp.JSON200 == nil {
			return errors.Errorf("unexpected list snippets status %d: %s", resp.StatusCode(), string(resp.Body))
		}

		allResponses = append(allResponses, resp.JSON200)

		if resp.JSON200.Cursor == nil || *resp.JSON200.Cursor == "" {
			break
		}

		currentCursor = *resp.JSON200.Cursor
	}

	switch utils.OutputFormat.Value {
	case utils.OutputPretty:
		var table strings.Builder
		table.WriteString(`|ID|NAME|VISIBILITY|OWNER|CREATED AT (UTC)|UPDATED AT (UTC)|
|-|-|-|-|-|-|
`)
		for _, resp := range allResponses {
			for _, snippet := range resp.Data {
				fmt.Fprintf(&table, "|`%s`|`%s`|`%s`|`%s`|`%s`|`%s`|\n",
					snippet.Id,
					strings.ReplaceAll(snippet.Name, "|", "\\|"),
					strings.ReplaceAll(string(snippet.Visibility), "|", "\\|"),
					strings.ReplaceAll(snippet.Owner.Username, "|", "\\|"),
					utils.FormatTimestamp(snippet.InsertedAt),
					utils.FormatTimestamp(snippet.UpdatedAt),
				)
			}
		}
		return utils.RenderTable(table.String())
	case utils.OutputEnv:
		return errors.New(utils.ErrEnvNotSupported)
	}

	// Flatten all snippets for JSON/TOML output
	var allSnippets []interface{}
	for _, resp := range allResponses {
		for _, snippet := range resp.Data {
			allSnippets = append(allSnippets, snippet)
		}
	}

	return utils.EncodeOutput(utils.OutputFormat.Value, os.Stdout, map[string]interface{}{
		"data": allSnippets,
	})
}
