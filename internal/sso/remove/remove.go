package remove

import (
	"context"
	"net/http"
	"os"

	"github.com/go-errors/errors"
	"github.com/google/uuid"
	"github.com/supabase/cli/internal/sso/internal/render"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/api"
)

func Run(ctx context.Context, ref, providerId, format string) error {
	parsed, err := uuid.Parse(providerId)
	if err != nil {
		return errors.Errorf("failed to parse provider ID: %w", err)
	}
	resp, err := utils.GetSupabase().V1DeleteASsoProviderWithResponse(ctx, ref, parsed)
	if err != nil {
		return errors.Errorf("failed to remove sso provider: %w", err)
	}

	if resp.JSON200 == nil {
		if resp.StatusCode() == http.StatusNotFound {
			return errors.Errorf("An identity provider with ID %q could not be found.", providerId)
		}

		return errors.New("Unexpected error removing identity provider: " + string(resp.Body))
	}

	switch format {
	case utils.OutputPretty:
		return render.SingleMarkdown(api.GetProviderResponse(*resp.JSON200))
	case utils.OutputEnv:
		return nil
	default:
		return utils.EncodeOutput(format, os.Stdout, resp.JSON200)
	}
}
