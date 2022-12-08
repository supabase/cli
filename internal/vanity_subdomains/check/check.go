package check

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/api"
)

func Run(ctx context.Context, projectRefArg string, desiredSubdomain string, fsys afero.Fs) error {
	// 1. Sanity checks.
	projectRef := projectRefArg
	subdomain := strings.TrimSpace(desiredSubdomain)
	{
		if len(projectRefArg) == 0 {
			ref, err := utils.LoadProjectRef(fsys)
			if err != nil {
				return err
			}
			projectRef = ref
		} else if !utils.ProjectRefPattern.MatchString(projectRef) {
			return errors.New("Invalid project ref format. Must be like `abcdefghijklmnopqrst`.")
		}
	}

	// 2. check if the subdomain is available
	{
		resp, err := utils.GetSupabase().CheckVanitySubdomainAvailabilityWithResponse(ctx, projectRef, api.CheckVanitySubdomainAvailabilityJSONRequestBody{
			VanitySubdomain: subdomain,
		})
		if err != nil {
			return err
		}
		if resp.JSON201 == nil {
			return errors.New("failed to check subdomain availability: " + string(resp.Body))
		}
		fmt.Printf("Subdomain %s available: %+v\n", subdomain, resp.JSON201.Available)
		return nil
	}
}
