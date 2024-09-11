package create

import (
	"context"

	"github.com/go-errors/errors"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/api"
)

func Run(ctx context.Context, name string) (*api.OrganizationResponseV1, error) {
	resp, err := utils.GetSupabase().V1CreateAnOrganizationWithResponse(ctx, api.V1CreateAnOrganizationJSONRequestBody{Name: name})
	if err != nil {
		return nil, errors.Errorf("failed to create organization: %w", err)
	}

	if resp.JSON201 == nil {
		return nil, errors.New("Unexpected error creating organization: " + string(resp.Body))
	}

	return resp.JSON201, nil
}
