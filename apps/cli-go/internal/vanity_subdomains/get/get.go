package get

import (
	"context"
	"fmt"
	"os"

	"github.com/go-errors/errors"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
)

func Run(ctx context.Context, projectRef string, fsys afero.Fs) error {
	resp, err := utils.GetSupabase().V1GetVanitySubdomainConfigWithResponse(ctx, projectRef)
	if err != nil {
		return errors.Errorf("failed to get vanity subdomain: %w", err)
	} else if resp.JSON200 == nil {
		return errors.Errorf("unexpected vanity subdomain status %d: %s", resp.StatusCode(), string(resp.Body))
	}
	if utils.OutputFormat.Value != utils.OutputPretty {
		return utils.EncodeOutput(utils.OutputFormat.Value, os.Stdout, *resp.JSON200)
	}
	fmt.Printf("Status: %s\n", resp.JSON200.Status)
	if resp.JSON200.CustomDomain != nil {
		fmt.Printf("Vanity subdomain: %s\n", *resp.JSON200.CustomDomain)
	}
	return nil
}
