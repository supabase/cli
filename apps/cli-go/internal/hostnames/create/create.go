package create

import (
	"context"
	"os"

	"github.com/go-errors/errors"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/hostnames"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/api"
)

func Run(ctx context.Context, projectRef string, customHostname string, fsys afero.Fs) error {
	// 1. verify that a CNAME is set as it simplifies the checks used for verifying ownership
	err := hostnames.VerifyCNAME(ctx, projectRef, customHostname)
	if err != nil {
		return err
	}
	// 2. create custom hostname
	resp, err := utils.GetSupabase().V1UpdateHostnameConfigWithResponse(ctx, projectRef, api.V1UpdateHostnameConfigJSONRequestBody{
		CustomHostname: customHostname,
	})
	if err != nil {
		return errors.Errorf("failed to create custom hostname: %w", err)
	} else if resp.JSON201 == nil {
		return errors.Errorf("unexpected create hostname status %d: %s", resp.StatusCode(), string(resp.Body))
	}
	hostnames.PrintStatus(resp.JSON201, os.Stderr)
	if utils.OutputFormat.Value != utils.OutputPretty {
		return utils.EncodeOutput(utils.OutputFormat.Value, os.Stdout, *resp.JSON201)
	}
	return nil
}
