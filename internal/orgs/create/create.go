package create

import (
	"context"
	"fmt"
	"os"

	"github.com/go-errors/errors"
	"github.com/supabase/cli/internal/orgs/list"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/api"
)

func Run(ctx context.Context, name string) error {
	resp, err := utils.GetSupabase().V1CreateAnOrganizationWithResponse(ctx, api.V1CreateAnOrganizationJSONRequestBody{Name: name})
	if err != nil {
		return errors.Errorf("failed to create organization: %w", err)
	} else if resp.JSON201 == nil {
		return errors.Errorf("unexpected create organization status %d: %s", resp.StatusCode(), string(resp.Body))
	}

	fmt.Println("Created organization:", resp.JSON201.Id)
	if utils.OutputFormat.Value == utils.OutputPretty {
		table := list.ToMarkdown([]api.OrganizationResponseV1{*resp.JSON201})
		return utils.RenderTable(table)
	}
	return utils.EncodeOutput(utils.OutputFormat.Value, os.Stdout, *resp.JSON201)
}
