package update

import (
	"context"
	"fmt"

	"github.com/go-errors/errors"
	"github.com/google/uuid"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/api"
)

func Run(ctx context.Context, branchId string, body api.UpdateBranchBody, fsys afero.Fs) error {
	parsed, err := uuid.Parse(branchId)
	if err != nil {
		return errors.Errorf("failed to parse branch ID: %w", err)
	}
	resp, err := utils.GetSupabase().V1UpdateABranchConfigWithResponse(ctx, parsed, body)
	if err != nil {
		return errors.Errorf("failed to update preview branch: %w", err)
	}
	if resp.JSON200 == nil {
		return errors.New("Unexpected error updating preview branch: " + string(resp.Body))
	}
	fmt.Println("Updated preview branch:", resp.JSON200.Id)
	return nil
}
