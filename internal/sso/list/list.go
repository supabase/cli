package list

import (
	"context"
	"errors"
	"net/http"
	"os"

	"github.com/supabase/cli/internal/sso/internal/render"
	"github.com/supabase/cli/internal/utils"
)

func Run(ctx context.Context, ref, format string) error {
	resp, err := utils.GetSupabase().ListAllProvidersWithResponse(ctx, ref)
	if err != nil {
		return err
	}

	if resp.JSON200 == nil {
		if resp.StatusCode() == http.StatusNotFound {
			return errors.New("Looks like SAML 2.0 support is not enabled for this project. Please use the dashboard to enable it.")
		}

		return errors.New("unexpected error listing identity providers: " + string(resp.Body))
	}

	switch format {
	case utils.OutputPretty:
		return render.ListMarkdown(resp.JSON200.Items)

	default:
		return utils.EncodeOutput(format, os.Stdout, map[string]any{
			"providers": resp.JSON200.Items,
		})
	}
}
