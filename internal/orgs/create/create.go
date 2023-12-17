package create

import (
	"context"
	"fmt"

	"github.com/go-errors/errors"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/api"
)

func Run(ctx context.Context, name string) error {
	resp, err := utils.GetSupabase().CreateOrganizationWithResponse(ctx, api.CreateOrganizationJSONRequestBody{Name: name})
	if err != nil {
		return errors.Errorf("failed to create organization: %w", err)
	}

	if resp.JSON201 == nil {
		return errors.New("Unexpected error creating organization: " + string(resp.Body))
	}

	fmt.Println("Created organization:", resp.JSON201.Id)
	return nil
}
