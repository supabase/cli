package list

import (
	"context"
	"fmt"
	"os"
	"strings"

	"github.com/go-errors/errors"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/api"
)

func Run(ctx context.Context) error {
	resp, err := utils.GetSupabase().V1ListAllOrganizationsWithResponse(ctx)
	if err != nil {
		return errors.Errorf("failed to list organizations: %w", err)
	} else if resp.JSON200 == nil {
		return errors.Errorf("unexpected list organizations status %d: %s", resp.StatusCode(), string(resp.Body))
	}

	switch utils.OutputFormat.Value {
	case utils.OutputPretty:
		table := ToMarkdown(*resp.JSON200)
		return utils.RenderTable(table)
	case utils.OutputToml:
		return utils.EncodeOutput(utils.OutputFormat.Value, os.Stdout, struct {
			Organizations []api.OrganizationResponseV1 `toml:"organizations"`
		}{
			Organizations: *resp.JSON200,
		})
	case utils.OutputEnv:
		return errors.New(utils.ErrEnvNotSupported)
	}

	return utils.EncodeOutput(utils.OutputFormat.Value, os.Stdout, *resp.JSON200)
}

func ToMarkdown(orgs []api.OrganizationResponseV1) string {
	table := `|ID|NAME|
|-|-|
`
	for _, org := range orgs {
		table += fmt.Sprintf("|`%s`|`%s`|\n", org.Id, strings.ReplaceAll(org.Name, "|", "\\|"))
	}
	return table
}
