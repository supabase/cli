package activate

import (
	"context"
	"fmt"
	"os"

	"github.com/go-errors/errors"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/hostnames"
	"github.com/supabase/cli/internal/utils"
)

func Run(ctx context.Context, projectRef string, fsys afero.Fs) error {
	resp, err := utils.GetSupabase().V1ActivateCustomHostnameWithResponse(ctx, projectRef)
	if err != nil {
		return errors.Errorf("failed to activate custom hostname: %w", err)
	} else if resp.JSON201 == nil {
		return errors.Errorf("unexpected activate hostname status %d: %s", resp.StatusCode(), string(resp.Body))
	}
	if utils.OutputFormat.Value != utils.OutputPretty {
		return utils.EncodeOutput(utils.OutputFormat.Value, os.Stdout, *resp.JSON201)
	}
	status, err := hostnames.TranslateStatus(resp.JSON201, false)
	if err != nil {
		return err
	}
	fmt.Fprintln(os.Stderr, status)
	return nil
}
