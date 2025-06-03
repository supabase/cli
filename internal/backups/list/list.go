package list

import (
	"context"
	"os"

	"github.com/go-errors/errors"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/flags"
)

func Run(ctx context.Context) error {
	resp, err := utils.GetSupabase().V1ListAllBackupsWithResponse(ctx, flags.ProjectRef)
	if err != nil {
		return errors.Errorf("failed to list physical backups: %w", err)
	} else if resp.JSON200 == nil {
		return errors.Errorf("unexpected list backup status %d: %s", resp.StatusCode(), string(resp.Body))
	}
	return utils.EncodeOutput(utils.OutputFormat.Value, os.Stdout, *resp.JSON200)
}
