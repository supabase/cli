package update

import (
	"context"
	"errors"
	"fmt"

	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/api"
)

func Run(ctx context.Context, branchId string, body api.UpdateBranchBody, fsys afero.Fs) error {
	resp, err := utils.GetSupabase().UpdateBranchWithResponse(ctx, branchId, body)
	if err != nil {
		return err
	}
	if resp.JSON200 == nil {
		return errors.New("Unexpected error updating preview branch: " + string(resp.Body))
	}
	fmt.Println("Updated preview branch:", resp.JSON200.Id)
	return nil
}
