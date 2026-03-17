package delete

import (
	"context"
	"fmt"
	"net/http"

	"github.com/go-errors/errors"
	"github.com/supabase/cli/internal/branches/pause"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/api"
)

func Run(ctx context.Context, branchId string, force *bool) error {
	projectRef, err := pause.GetBranchProjectRef(ctx, branchId)
	if err != nil {
		return err
	}
	resp, err := utils.GetSupabase().V1DeleteABranchWithResponse(ctx, projectRef, &api.V1DeleteABranchParams{
		Force: force,
	})
	if err != nil {
		return errors.Errorf("failed to delete preview branch: %w", err)
	}
	if resp.StatusCode() != http.StatusOK {
		return errors.New("Unexpected error deleting preview branch: " + string(resp.Body))
	}
	fmt.Println("Deleted preview branch:", projectRef)
	return nil
}
