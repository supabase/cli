package activate

import (
	"context"
	"fmt"
	"os"

	"github.com/go-errors/errors"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/api"
)

func Run(ctx context.Context, projectRef string, desiredSubdomain string, fsys afero.Fs) error {
	resp, err := utils.GetSupabase().V1ActivateVanitySubdomainConfigWithResponse(ctx, projectRef, api.V1ActivateVanitySubdomainConfigJSONRequestBody{
		VanitySubdomain: desiredSubdomain,
	})
	if err != nil {
		return errors.Errorf("failed activate vanity subdomain: %w", err)
	} else if resp.JSON201 == nil {
		return errors.Errorf("unexpected activate vanity subdomain status %d: %s", resp.StatusCode(), string(resp.Body))
	}
	if utils.OutputFormat.Value != utils.OutputPretty {
		return utils.EncodeOutput(utils.OutputFormat.Value, os.Stdout, *resp.JSON201)
	}
	fmt.Printf("Activated vanity subdomain at %s\n", resp.JSON201.CustomDomain)
	return nil
}
