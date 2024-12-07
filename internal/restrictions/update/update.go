package update

import (
	"context"
	"fmt"
	"net"

	"github.com/go-errors/errors"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/api"
)

func Run(ctx context.Context, projectRef string, dbCidrsToAllow []string, bypassCidrChecks bool) error {
	// 1. separate CIDR to v4 and v6
	body := api.V1UpdateNetworkRestrictionsJSONRequestBody{
		DbAllowedCidrs:   &[]string{},
		DbAllowedCidrsV6: &[]string{},
	}
	for _, cidr := range dbCidrsToAllow {
		ip, _, err := net.ParseCIDR(cidr)
		if err != nil {
			return errors.Errorf("failed to parse IP: %s", cidr)
		}
		if ip.IsPrivate() && !bypassCidrChecks {
			return errors.Errorf("private IP provided: %s", cidr)
		}
		if ip.To4() != nil {
			*body.DbAllowedCidrs = append(*body.DbAllowedCidrs, cidr)
		} else {
			*body.DbAllowedCidrsV6 = append(*body.DbAllowedCidrsV6, cidr)
		}
	}

	// 2. update restrictions
	resp, err := utils.GetSupabase().V1UpdateNetworkRestrictionsWithResponse(ctx, projectRef, body)
	if err != nil {
		return errors.Errorf("failed to apply network restrictions: %w", err)
	}
	if resp.JSON201 == nil {
		return errors.New("failed to apply network restrictions: " + string(resp.Body))
	}

	fmt.Printf("DB Allowed IPv4 CIDRs: %+v\n", resp.JSON201.Config.DbAllowedCidrs)
	fmt.Printf("DB Allowed IPv6 CIDRs: %+v\n", resp.JSON201.Config.DbAllowedCidrsV6)
	fmt.Printf("Restrictions applied successfully: %+v\n", resp.JSON201.Status == "applied")
	return nil
}
