package get

import (
	"context"
	"fmt"
	"os"

	"github.com/go-errors/errors"
	"github.com/google/uuid"
	"github.com/jackc/pgconn"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/migration/list"
	"github.com/supabase/cli/internal/projects/apiKeys"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/api"
	"github.com/supabase/cli/pkg/cast"
)

func Run(ctx context.Context, branchId string, fsys afero.Fs) error {
	detail, err := getBranchDetail(ctx, branchId)
	if err != nil {
		return err
	}

	if utils.OutputFormat.Value != utils.OutputPretty {
		keys, err := apiKeys.RunGetApiKeys(ctx, detail.Ref)
		if err != nil {
			return err
		}
		pooler, err := getPoolerConfig(ctx, detail.Ref)
		if err != nil {
			return err
		}
		envs := toStandardEnvs(detail, pooler, keys)
		return utils.EncodeOutput(utils.OutputFormat.Value, os.Stdout, envs)
	}

	table := `|HOST|PORT|USER|PASSWORD|JWT SECRET|POSTGRES VERSION|STATUS|
|-|-|-|-|-|-|-|
` + fmt.Sprintf(
		"|`%s`|`%d`|`%s`|`%s`|`%s`|`%s`|`%s`|\n",
		detail.DbHost,
		detail.DbPort,
		*detail.DbUser,
		*detail.DbPass,
		*detail.JwtSecret,
		detail.PostgresVersion,
		detail.Status,
	)

	return list.RenderTable(table)
}

func getBranchDetail(ctx context.Context, branchId string) (api.BranchDetailResponse, error) {
	var result api.BranchDetailResponse
	parsed, err := uuid.Parse(branchId)
	if err != nil {
		return result, errors.Errorf("failed to parse branch ID: %w", err)
	}
	resp, err := utils.GetSupabase().V1GetABranchConfigWithResponse(ctx, parsed)
	if err != nil {
		return result, errors.Errorf("failed to get branch: %w", err)
	} else if resp.JSON200 == nil {
		return result, errors.Errorf("unexpected get branch status %d: %s", resp.StatusCode(), string(resp.Body))
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
	return *resp.JSON200, nil
}

func getPoolerConfig(ctx context.Context, ref string) (api.SupavisorConfigResponse, error) {
	var result api.SupavisorConfigResponse
	resp, err := utils.GetSupabase().V1GetPoolerConfigWithResponse(ctx, ref)
	if err != nil {
		return result, errors.Errorf("failed to get pooler: %w", err)
	} else if resp.JSON200 == nil {
		return result, errors.Errorf("unexpected get pooler status %d: %s", resp.StatusCode(), string(resp.Body))
	}
	for _, config := range *resp.JSON200 {
		if config.DatabaseType == api.PRIMARY {
			return config, nil
		}
	}
	return result, errors.Errorf("primary database not found: %s", ref)
}

func toStandardEnvs(detail api.BranchDetailResponse, pooler api.SupavisorConfigResponse, keys []api.ApiKeyResponse) map[string]string {
	direct := pgconn.Config{
		Host:     detail.DbHost,
		Port:     cast.UIntToUInt16(cast.IntToUint(detail.DbPort)),
		User:     *detail.DbUser,
		Password: *detail.DbPass,
	}
	config, err := utils.ParsePoolerURL(pooler.ConnectionString)
	if err != nil {
		fmt.Fprintln(os.Stderr, utils.Yellow("WARNING:"), err)
		config = &direct
	} else {
		config.Password = direct.Password
	}
	envs := apiKeys.ToEnv(keys)
	envs["POSTGRES_URL"] = utils.ToPostgresURL(*config)
	envs["POSTGRES_URL_NON_POOLING"] = utils.ToPostgresURL(direct)
	envs["SUPABASE_URL"] = "https://" + utils.GetSupabaseHost(detail.Ref)
	envs["SUPABASE_JWT_SECRET"] = *detail.JwtSecret
	return envs
}
