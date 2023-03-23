package list

import (
	"context"
	"errors"
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
		return errors.New("unexpected error fetching identity provider: " + string(resp.Body))
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
