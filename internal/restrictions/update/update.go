package update

import (
	"context"
	"fmt"
	"net"
	"slices"

	"github.com/go-errors/errors"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/api"
)

// Run updates the network restriction lists using the provided CIDRs.
func Run(ctx context.Context, projectRef string, dbCidrsToAllow []string, bypassCidrChecks bool) error {
	newCidrsBody, err := buildRequestBody(dbCidrsToAllow, bypassCidrChecks)
	if err != nil {
		return err
	}

	resp, err := utils.GetSupabase().V1GetNetworkRestrictionsWithResponse(ctx, projectRef)
	if err != nil {
		return errors.Errorf("failed to retrieve network restrictions: %w", err)
	}
	if resp.JSON200 == nil {
		return errors.New("failed to retrieve network restrictions: " + string(resp.Body))
	}

	currentV4 := []string{}
	if resp.JSON200.Config.DbAllowedCidrs != nil {
		currentV4 = append(currentV4, *resp.JSON200.Config.DbAllowedCidrs...)
	}
	currentV6 := []string{}
	if resp.JSON200.Config.DbAllowedCidrsV6 != nil {
		currentV6 = append(currentV6, *resp.JSON200.Config.DbAllowedCidrsV6...)
	}

	if newCidrsBody.DbAllowedCidrs != nil {
		currentV4 = appendUnique(currentV4, *newCidrsBody.DbAllowedCidrs...)
	}
	if newCidrsBody.DbAllowedCidrsV6 != nil {
		currentV6 = appendUnique(currentV6, *newCidrsBody.DbAllowedCidrsV6...)
	}

	body := api.V1UpdateNetworkRestrictionsJSONRequestBody{
		DbAllowedCidrs:   &currentV4,
		DbAllowedCidrsV6: &currentV6,
	}
	return Apply(ctx, projectRef, body)
}

// Apply submits a pre-built network restriction payload to the Supabase API.
func Apply(ctx context.Context, projectRef string, body api.V1UpdateNetworkRestrictionsJSONRequestBody) error {
	resp, err := utils.GetSupabase().V1UpdateNetworkRestrictionsWithResponse(ctx, projectRef, body)
	if err != nil {
		return errors.Errorf("failed to apply network restrictions: %w", err)
	}
	if resp.JSON201 == nil {
		return errors.New("failed to apply network restrictions: " + string(resp.Body))
	}

	if resp.JSON201.Config.DbAllowedCidrs != nil {
		fmt.Printf("DB Allowed IPv4 CIDRs: %+v\n", *resp.JSON201.Config.DbAllowedCidrs)
	} else {
		fmt.Println("DB Allowed IPv4 CIDRs: []")
	}
	if resp.JSON201.Config.DbAllowedCidrsV6 != nil {
		fmt.Printf("DB Allowed IPv6 CIDRs: %+v\n", *resp.JSON201.Config.DbAllowedCidrsV6)
	} else {
		fmt.Println("DB Allowed IPv6 CIDRs: []")
	}
	fmt.Printf("Restrictions applied successfully")
	return nil
}

func buildRequestBody(dbCidrsToAllow []string, bypassCidrChecks bool) (api.V1UpdateNetworkRestrictionsJSONRequestBody, error) {
	body := api.V1UpdateNetworkRestrictionsJSONRequestBody{
		DbAllowedCidrs:   &[]string{},
		DbAllowedCidrsV6: &[]string{},
	}
	for _, cidr := range dbCidrsToAllow {
		ip, _, err := net.ParseCIDR(cidr)
		if err != nil {
			return api.V1UpdateNetworkRestrictionsJSONRequestBody{}, errors.Errorf("failed to parse IP: %s", cidr)
		}
		if ip.IsPrivate() && !bypassCidrChecks {
			return api.V1UpdateNetworkRestrictionsJSONRequestBody{}, errors.Errorf("private IP provided: %s", cidr)
		}
		if ip.To4() != nil {
			*body.DbAllowedCidrs = append(*body.DbAllowedCidrs, cidr)
		} else {
			*body.DbAllowedCidrsV6 = append(*body.DbAllowedCidrsV6, cidr)
		}
	}
	return body, nil
}

func appendUnique(existing []string, additions ...string) []string {
	for _, cidr := range additions {
		if !slices.Contains(existing, cidr) {
			existing = append(existing, cidr)
		}
	}
	return existing
}
