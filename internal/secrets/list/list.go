package list

import (
	"context"
	"crypto/md5"
	"errors"
	"fmt"
	"strings"

	"github.com/supabase/cli/internal/migration/list"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
)

func Run(ctx context.Context, projectRef string, fsys afero.Fs) error {
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

	return list.RenderTable(table)
}
