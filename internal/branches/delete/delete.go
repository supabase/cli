package delete

import (
	"context"
	"errors"
	"fmt"
	"net/http"

	"github.com/supabase/cli/internal/utils"
)

func Run(ctx context.Context, branchId string) error {
	resp, err := utils.GetSupabase().DeleteBranchWithResponse(ctx, branchId)
	if err != nil {
		return err
	}
	if resp.StatusCode() != http.StatusOK {
		return errors.New("Unexpected error deleting preview branch: " + string(resp.Body))
	}
	fmt.Println("Deleted preview branch:", branchId)
	return nil
}
