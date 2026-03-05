package get

import (
	"context"
	"fmt"
	"os"

	"github.com/go-errors/errors"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/api"
)

func Run(ctx context.Context, projectRef string, fsys afero.Fs) error {
	resp, err := utils.GetSupabase().V1GetSslEnforcementConfigWithResponse(ctx, projectRef)
	if err != nil {
		return errors.Errorf("failed to retrieve SSL enforcement config: %w", err)
	} else if resp.JSON200 == nil {
		return errors.Errorf("unexpected SSL enforcement status %d: %s", resp.StatusCode(), string(resp.Body))
	}
	if utils.OutputFormat.Value != utils.OutputPretty {
		return utils.EncodeOutput(utils.OutputFormat.Value, os.Stdout, *resp.JSON200)
	}
	return PrintSSLStatus(*resp.JSON200)
}

func PrintSSLStatus(ssl api.SslEnforcementResponse) error {
	if ssl.CurrentConfig.Database && ssl.AppliedSuccessfully {
		fmt.Println("SSL is being enforced.")
	} else {
		fmt.Println("SSL is *NOT* being enforced.")
	}
	return nil
}
