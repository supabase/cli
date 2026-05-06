package list

import (
	"context"
	"net/http"
	"os"

	"github.com/go-errors/errors"
	"github.com/supabase/cli/internal/sso/internal/render"
	"github.com/supabase/cli/internal/telemetry"
	"github.com/supabase/cli/internal/utils"
)

func Run(ctx context.Context, ref, format string) error {
	resp, err := utils.GetSupabase().V1ListAllSsoProviderWithResponse(ctx, ref)
	if err != nil {
		return errors.Errorf("failed to list sso providers: %w", err)
	}

	if resp.JSON200 == nil {
		if orgSlug, isGated := utils.SuggestUpgradeOnError(ctx, ref, "auth.saml_2", resp.StatusCode()); isGated {
			telemetry.TrackUpgradeSuggested(ctx, "auth.saml_2", orgSlug)
		}
		if resp.StatusCode() == http.StatusNotFound {
			return errors.New("Looks like SAML 2.0 support is not enabled for this project. Please use the dashboard to enable it.")
		}
		return errors.New("unexpected error listing identity providers: " + string(resp.Body))
	}

	switch format {
	case utils.OutputPretty:
		return render.ListMarkdown(*resp.JSON200)

	default:
		return utils.EncodeOutput(format, os.Stdout, map[string]any{
			"providers": resp.JSON200.Items,
		})
	}
}
