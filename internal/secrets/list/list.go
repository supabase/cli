package list

import (
	"context"
	"crypto/md5"
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
		resp, err := utils.GetSupabase().GetSecretsWithResponse(ctx, projectRef)
		if err != nil {
			return err
		}

		if resp.JSON200 == nil {
			return errors.New("Unexpected error retrieving project secrets: " + string(resp.Body))
		}

		table := `|NAME|DIGEST|
|-|-|
`
		for _, secret := range *resp.JSON200 {
			table += fmt.Sprintf("|`%s`|`%x`|\n", strings.ReplaceAll(secret.Name, "|", "\\|"), md5.Sum([]byte(secret.Value)))
		}

		r, err := glamour.NewTermRenderer(
			glamour.WithAutoStyle(),
			glamour.WithWordWrap(-1),
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
