package list

import (
	"context"
	"fmt"
	"strings"

	"github.com/go-errors/errors"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/migration/list"
	"github.com/supabase/cli/internal/utils"
)

func Run(ctx context.Context, projectRef string, fsys afero.Fs) error {
	resp, err := utils.GetSupabase().GetSecretsWithResponse(ctx, projectRef)
	if err != nil {
		return errors.Errorf("failed to list secrets: %w", err)
	}

	if resp.JSON200 == nil {
		return errors.New("Unexpected error retrieving project secrets: " + string(resp.Body))
	}

	table := `|NAME|DIGEST|
|-|-|
`
	for _, secret := range *resp.JSON200 {
		table += fmt.Sprintf("|`%s`|`%s`|\n", strings.ReplaceAll(secret.Name, "|", "\\|"), secret.Value)
	}

	return list.RenderTable(table)
}
