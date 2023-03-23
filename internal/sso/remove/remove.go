package remove

import (
	"context"
	"errors"
	"os"

	"github.com/supabase/cli/internal/sso/internal/render"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/api"
)

func Run(ctx context.Context, ref, providerId, format string) error {
	resp, err := utils.GetSupabase().RemoveProviderByIdWithResponse(ctx, ref, providerId)
	if err != nil {
		return err
	}

	if resp.JSON200 == nil {
		return errors.New("Unexpected error removing identity provider: " + string(resp.Body))
	}

	switch format {
	case utils.OutputPretty:
		return render.SingleMarkdown(api.Provider{
			Id:        resp.JSON200.Id,
			Saml:      resp.JSON200.Saml,
			Domains:   resp.JSON200.Domains,
			CreatedAt: resp.JSON200.CreatedAt,
			UpdatedAt: resp.JSON200.UpdatedAt,
		})

	default:
		return utils.EncodeOutput(format, os.Stdout, resp.JSON200)
	}
}
