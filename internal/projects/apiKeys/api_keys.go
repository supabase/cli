package apiKeys

import (
	"context"
	"errors"
	"fmt"

	"github.com/charmbracelet/bubbles/table"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
	"github.com/charmbracelet/lipgloss"
)

func Run(ctx context.Context, projectRef string, fsys afero.Fs) error {
	// 1. Sanity checks.
	// 2. Print api-keys.
	{
		resp, err := utils.GetSupabase().GetProjectApiKeysWithResponse(ctx, projectRef)
		if err != nil {
			return err
		}

		if resp.JSON200 == nil {
			return errors.New("Unexpected error retrieving project api-keys: " + string(resp.Body))
		}

		columns := []table.Column{
			{Title: "NAME", Width: 20},
			{Title: "KEY VALUE", Width: 50},
		}

		rows := []table.Row{}

		for _, api_key := range *resp.JSON200 {
			rows = append(rows, table.Row{
				api_key.Name,
				api_key.ApiKey,
			})
		}

		var baseStyle = lipgloss.NewStyle().
		BorderStyle(lipgloss.NormalBorder()).
		BorderForeground(lipgloss.Color("#85e0b7"))

		t := table.New(
			table.WithColumns(columns),
			table.WithRows(rows),
			table.WithHeight(5),
		)

		s := table.DefaultStyles()
		s.Header = s.Header.
			BorderStyle(lipgloss.NormalBorder()).
			BorderForeground(lipgloss.Color("#85e0b7")).
			BorderBottom(true).
			Bold(true).
			Foreground(lipgloss.Color("#85e0b7"))
		s.Selected = s.Selected.Foreground(lipgloss.Color("#ffffff"))

		t.SetStyles(s)

		fmt.Print(baseStyle.Render(t.View()) + "\n")
	}

	return nil
}
