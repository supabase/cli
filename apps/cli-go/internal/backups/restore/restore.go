package restore

import (
	"context"
	"fmt"
	"net/http"
	"os"

	"github.com/go-errors/errors"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/flags"
	"github.com/supabase/cli/pkg/api"
)

func Run(ctx context.Context, timestamp int64) error {
	body := api.V1RestorePitrBody{RecoveryTimeTargetUnix: timestamp}
	if resp, err := utils.GetSupabase().V1RestorePitrBackupWithResponse(ctx, flags.ProjectRef, body); err != nil {
		return errors.Errorf("failed to restore backup: %w", err)
	} else if resp.StatusCode() != http.StatusCreated {
		return errors.Errorf("unexpected restore backup status %d: %s", resp.StatusCode(), string(resp.Body))
	}
	fmt.Fprintln(os.Stderr, "Started PITR restore:", flags.ProjectRef)
	return nil
}
