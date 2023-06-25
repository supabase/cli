package list

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/migration/list"
	"github.com/supabase/cli/internal/utils"
)

type Organization struct {
	Id   string `json:"id"`
	Name string `json:"name"`
}

func Run(ctx context.Context, fsys afero.Fs) error {
	resp, err := utils.GetSupabase().GetOrganizationsWithResponse(ctx)
	if err != nil {
		return err
	}

	if resp.JSON200 == nil {
		return errors.New("Unexpected error retrieving organizations: " + string(resp.Body))
	}

	table := `|ID|NAME|
|-|-|
`
	for _, org := range *resp.JSON200 {
		table += fmt.Sprintf("|`%s`|`%s`|\n", org.Id, strings.ReplaceAll(org.Name, "|", "\\|"))
	}

	return list.RenderTable(table)
}
