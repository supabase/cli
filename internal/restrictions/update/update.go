package update

import (
	"context"
	"fmt"
	"net"

	"github.com/go-errors/errors"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/api"
)

// Run updates the network restriction lists using the provided CIDRs.
func Run(ctx context.Context, projectRef string, dbCidrsToAllow []string, bypassCidrChecks bool, appendMode bool) error {
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

	if appendMode {
		return ApplyPatch(ctx, projectRef, body)
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
	fmt.Printf("Restrictions applied successfully: %+v\n", resp.JSON201.Status == api.NetworkRestrictionsResponseStatusApplied)
	return nil
}

// ApplyPatch submits a network restriction payload using PATCH (add/remove mode).
func ApplyPatch(ctx context.Context, projectRef string, body api.V1UpdateNetworkRestrictionsJSONRequestBody) error {
	patchBody := api.V1PatchNetworkRestrictionsJSONRequestBody{
		Add: &struct {
			DbAllowedCidrs   *[]string `json:"dbAllowedCidrs,omitempty"`
			DbAllowedCidrsV6 *[]string `json:"dbAllowedCidrsV6,omitempty"`
		}{
			DbAllowedCidrs:   body.DbAllowedCidrs,
			DbAllowedCidrsV6: body.DbAllowedCidrsV6,
		},
	}

	resp, err := utils.GetSupabase().V1PatchNetworkRestrictionsWithResponse(ctx, projectRef, patchBody)
	if err != nil {
		return errors.Errorf("failed to apply network restrictions: %w", err)
	}
	if resp.JSON200 == nil {
		return errors.New("failed to apply network restrictions: " + string(resp.Body))
	}

	var allowedIPv4, allowedIPv6 []string
	if allowed := resp.JSON200.Config.DbAllowedCidrs; allowed != nil {
		for _, cidr := range *allowed {
			switch cidr.Type {
			case api.NetworkRestrictionsV2ResponseConfigDbAllowedCidrsTypeV4:
				allowedIPv4 = append(allowedIPv4, cidr.Address)
			case api.NetworkRestrictionsV2ResponseConfigDbAllowedCidrsTypeV6:
				allowedIPv6 = append(allowedIPv6, cidr.Address)
			}
		}
	}

	fmt.Printf("DB Allowed IPv4 CIDRs: %+v\n", &allowedIPv4)
	fmt.Printf("DB Allowed IPv6 CIDRs: %+v\n", &allowedIPv6)
	fmt.Printf("Restrictions applied successfully: %+v\n", resp.JSON200.Status == api.NetworkRestrictionsV2ResponseStatusApplied)
	return nil
}
