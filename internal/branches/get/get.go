package get

import (
	"context"
	"errors"
	"fmt"

	"github.com/supabase/cli/internal/migration/list"
	"github.com/supabase/cli/internal/utils"
)

func Run(ctx context.Context, branchId string) error {
	resp, err := utils.GetSupabase().GetBranchDetailsWithResponse(ctx, branchId)
	if err != nil {
		return err
	}
	if resp.JSON200 == nil {
		return errors.New("Unexpected error retrieving preview branch: " + string(resp.Body))
	}

	masked := "******"
	if resp.JSON200.DbUser == nil {
		resp.JSON200.DbUser = &masked
	}
	if resp.JSON200.DbPass == nil {
		resp.JSON200.DbPass = &masked
	}
	if resp.JSON200.JwtSecret == nil {
		resp.JSON200.JwtSecret = &masked
	}

	table := `|HOST|PORT|USER|PASSWORD|JWT SECRET|POSTGRES VERSION|STATUS|
|-|-|-|-|-|-|-|
` + fmt.Sprintf(
		"|`%s`|`%d`|`%s`|`%s`|`%s`|`%s`|`%s`|\n",
		resp.JSON200.DbHost,
		resp.JSON200.DbPort,
		*resp.JSON200.DbUser,
		*resp.JSON200.DbPass,
		*resp.JSON200.JwtSecret,
		resp.JSON200.PostgresVersion,
		resp.JSON200.Status,
	)
	return list.RenderTable(table)
}
