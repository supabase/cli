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
	if appendMode {
		// Use PATCH endpoint for append mode
		return runPatch(ctx, projectRef, dbCidrsToAllow, bypassCidrChecks)
	}

	// Use POST endpoint for replace mode
	newCidrsBody, err := buildRequestBody(dbCidrsToAllow, bypassCidrChecks)
	if err != nil {
		return err
	}

	return Apply(ctx, projectRef, newCidrsBody)
}

func runPatch(ctx context.Context, projectRef string, dbCidrsToAllow []string, bypassCidrChecks bool) error {
	addBody, err := buildRequestBody(dbCidrsToAllow, bypassCidrChecks)
	if err != nil {
		return err
	}

	patchBody := api.V1PatchNetworkRestrictionsJSONRequestBody{
		Add: &struct {
			DbAllowedCidrs   *[]string `json:"dbAllowedCidrs,omitempty"`
			DbAllowedCidrsV6 *[]string `json:"dbAllowedCidrsV6,omitempty"`
		}{
			DbAllowedCidrs:   addBody.DbAllowedCidrs,
			DbAllowedCidrsV6: addBody.DbAllowedCidrsV6,
		},
	}

	return ApplyPatch(ctx, projectRef, patchBody)
}

// Apply submits a pre-built network restriction payload to the Supabase API using POST (replace mode).
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
	fmt.Printf("Restrictions applied successfully\n")
	return nil
}

// ApplyPatch submits a network restriction payload using PATCH (add/remove mode).
func ApplyPatch(ctx context.Context, projectRef string, body api.V1PatchNetworkRestrictionsJSONRequestBody) error {
	resp, err := utils.GetSupabase().V1PatchNetworkRestrictionsWithResponse(ctx, projectRef, body)
	if err != nil {
		return errors.Errorf("failed to apply network restrictions: %w", err)
	}
	if resp.JSON200 == nil {
		return errors.New("failed to apply network restrictions: " + string(resp.Body))
	}

	if resp.JSON200.Config.DbAllowedCidrs != nil {
		fmt.Println("DB Allowed CIDRs:")
		for _, cidr := range *resp.JSON200.Config.DbAllowedCidrs {
			fmt.Printf("  - %s (%s)\n", cidr.Address, cidr.Type)
		}
	} else {
		fmt.Println("DB Allowed CIDRs: []")
	}
	fmt.Printf("Restrictions applied successfully\n")
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
