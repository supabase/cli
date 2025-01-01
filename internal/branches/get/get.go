package get

import (
	"context"
	"fmt"

	"github.com/go-errors/errors"
	"github.com/jackc/pgconn"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/migration/list"
	"github.com/supabase/cli/internal/utils"
)

func Run(ctx context.Context, branchId string, env string, fsys afero.Fs) error {
	resp, err := utils.GetSupabase().V1GetABranchConfigWithResponse(ctx, branchId)
	if err != nil {
		return errors.Errorf("failed to retrieve preview branch: %w", err)
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

	config := pgconn.Config{
		Host: utils.GetSupabaseDbHost(resp.JSON200.DbHost),
		Port: uint16(resp.JSON200.DbPort),
		User: *resp.JSON200.DbUser,
		Password: *resp.JSON200.DbPass,
	}

	table := `|HOST|PORT|USER|PASSWORD|JWT SECRET|POSTGRES VERSION|STATUS|POSTGRES URL|
|-|-|-|-|-|-|-|-|
` + fmt.Sprintf(
		"|`%s`|`%d`|`%s`|`%s`|`%s`|`%s`|`%s`|`%s`|\n",
		resp.JSON200.DbHost,
		resp.JSON200.DbPort,
		*resp.JSON200.DbUser,
		*resp.JSON200.DbPass,
		*resp.JSON200.JwtSecret,
		resp.JSON200.PostgresVersion,
		resp.JSON200.Status,
		"",
	)

	return list.RenderTable(table)
}
