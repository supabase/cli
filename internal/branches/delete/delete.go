package delete

import (
	"context"
	"fmt"
	"net/http"

	"github.com/go-errors/errors"
	"github.com/google/uuid"
	"github.com/supabase/cli/internal/utils"
)

func Run(ctx context.Context, branchId string) error {
	parsed, err := uuid.Parse(branchId)
	if err != nil {
		return errors.Errorf("failed to parse branch ID: %w", err)
	}
	resp, err := utils.GetSupabase().V1DeleteABranchWithResponse(ctx, parsed)
	if err != nil {
		return errors.Errorf("failed to delete preview branch: %w", err)
	}
	if resp.StatusCode() != http.StatusOK {
		return errors.New("Unexpected error deleting preview branch: " + string(resp.Body))
	}
	fmt.Println("Deleted preview branch:", branchId)
	return nil
}
