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

type Secret struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

func Run(ctx context.Context, fsys afero.Fs) error {
	// 1. Sanity checks.
	{
		if err := utils.AssertSupabaseCliIsSetUpFS(fsys); err != nil {
			return err
		}
		if err := utils.AssertIsLinkedFS(fsys); err != nil {
			return err
		}
	}

	// 2. Print secrets.
	{
		projectRefBytes, err := afero.ReadFile(fsys, utils.ProjectRefPath)
		if err != nil {
			return err
		}
		projectRef := string(projectRefBytes)

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
