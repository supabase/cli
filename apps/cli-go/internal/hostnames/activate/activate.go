package activate

import (
	"context"
	"os"

	"github.com/go-errors/errors"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/hostnames"
	"github.com/supabase/cli/internal/telemetry"
	"github.com/supabase/cli/internal/utils"
)

func Run(ctx context.Context, projectRef string, fsys afero.Fs) error {
	resp, err := utils.GetSupabase().V1ActivateCustomHostnameWithResponse(ctx, projectRef)
	if err != nil {
		return errors.Errorf("failed to activate custom hostname: %w", err)
	} else if resp.JSON201 == nil {
		if feature, orgSlug, isGated := utils.SuggestUpgradeOnError(ctx, projectRef, "", resp.StatusCode(), resp.Body); isGated {
			telemetry.TrackUpgradeSuggested(ctx, feature, orgSlug)
		}
		return errors.Errorf("unexpected activate hostname status %d: %s", resp.StatusCode(), string(resp.Body))
	}
	hostnames.PrintStatus(resp.JSON201, os.Stderr)
	if utils.OutputFormat.Value != utils.OutputPretty {
		return utils.EncodeOutput(utils.OutputFormat.Value, os.Stdout, *resp.JSON201)
	}
	return nil
}
