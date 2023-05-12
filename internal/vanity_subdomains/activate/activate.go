package activate

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/api"
)

func Run(ctx context.Context, projectRef string, desiredSubdomain string, fsys afero.Fs) error {
	// 1. Sanity checks.
	subdomain := strings.TrimSpace(desiredSubdomain)
	{
		if len(subdomain) == 0 {
			return errors.New("non-empty vanity subdomain expected")
		}
	}

	// 2. create vanity subdomain
	{
		resp, err := utils.GetSupabase().ActivateVanitySubdomainPleaseWithResponse(ctx, projectRef, api.ActivateVanitySubdomainPleaseJSONRequestBody{
			VanitySubdomain: subdomain,
		})
		if err != nil {
			return err
		}
		if resp.JSON201 == nil {
			return errors.New("failed to create vanity subdomain config: " + string(resp.Body))
		}
		fmt.Printf("Activated vanity subdomain at %s\n", resp.JSON201.CustomDomain)
		return nil
	}
}
