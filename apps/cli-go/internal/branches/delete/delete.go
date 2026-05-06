package delete

import (
	"context"
	"fmt"
	"net/http"
	"os"

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
	} else if resp.StatusCode() != http.StatusOK {
		return errors.Errorf("unexpected delete branch status %d: %s", resp.StatusCode(), string(resp.Body))
	}
	fmt.Fprintln(os.Stderr, "Deleted preview branch:", projectRef)
	return nil
}
