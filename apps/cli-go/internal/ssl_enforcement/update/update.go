package update

import (
	"context"
	"os"

	"github.com/go-errors/errors"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/ssl_enforcement/get"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/api"
)

func Run(ctx context.Context, projectRef string, enforceDbSsl bool, fsys afero.Fs) error {
	body := api.V1UpdateSslEnforcementConfigJSONRequestBody{}
	body.RequestedConfig.Database = enforceDbSsl
	resp, err := utils.GetSupabase().V1UpdateSslEnforcementConfigWithResponse(ctx, projectRef, body)
	if err != nil {
		return errors.Errorf("failed to update ssl enforcement: %w", err)
	} else if resp.JSON200 == nil {
		return errors.Errorf("unexpected update SSL status %d: %s", resp.StatusCode(), string(resp.Body))
	}
	if utils.OutputFormat.Value != utils.OutputPretty {
		return utils.EncodeOutput(utils.OutputFormat.Value, os.Stdout, *resp.JSON200)
	}
	return get.PrintSSLStatus(*resp.JSON200)
}
