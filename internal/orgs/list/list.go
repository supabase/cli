package list

import (
	"context"

	"github.com/go-errors/errors"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/api"
)

func Run(ctx context.Context) (*[]api.OrganizationResponseV1, error) {
	resp, err := utils.GetSupabase().V1ListAllOrganizationsWithResponse(ctx)
	if err != nil {
		return nil, errors.Errorf("failed to list organizations: %w", err)
	}

	if resp.JSON200 == nil {
		return nil, errors.New("Unexpected error retrieving organizations: " + string(resp.Body))
	}

	return resp.JSON200, nil
}
