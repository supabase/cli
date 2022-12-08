package update

import (
	"context"
	"errors"
	"fmt"
	"net"

	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/api"
)

func validateCidrs(cidrs []string, bypassChecks bool) error {
	for _, cidr := range cidrs {
		ip, _, err := net.ParseCIDR(cidr)
		if err != nil {
			return fmt.Errorf("failed to parse IP: %s", cidr)
		}
		if ip.IsPrivate() && !bypassChecks {
			return fmt.Errorf("private IP provided: %s", cidr)
		}
		if ip.To4() == nil {
			return fmt.Errorf("only IPv4 supported at the moment: %s", cidr)
		}
	}
	return nil
}

func Run(ctx context.Context, projectRefArg string, dbCidrsToAllow []string, bypassCidrChecks bool, fsys afero.Fs) error {
	// 1. Sanity checks.
	projectRef := projectRefArg

	// 1. sanity checks
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
		err := validateCidrs(dbCidrsToAllow, bypassCidrChecks)
		if err != nil {
			return err
		}
	}

	// 2. update restrictions
	{
		resp, err := utils.GetSupabase().ApplyNetworkRestrictionsWithResponse(ctx, projectRef, api.ApplyNetworkRestrictionsJSONRequestBody{
			DbAllowedCidrs: dbCidrsToAllow,
		})
		if err != nil {
			return err
		}
		if resp.JSON201 == nil {
			return errors.New("failed to update network restrictions: " + string(resp.Body))
		}
		fmt.Printf("DB Allowed CIDRs: %+v\n", resp.JSON201.Config.DbAllowedCidrs)
		fmt.Printf("Restrictions applied successfully: %+v\n", resp.JSON201.Status == "applied")
		return nil
	}
}
