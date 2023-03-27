package update

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"

	"github.com/supabase/cli/internal/sso/internal/render"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/api"
)

func Run(ctx context.Context, ref, providerId string, params api.UpdateProviderByIdJSONRequestBody, addDomains, removeDomains []string, format string) error {
	getResp, err := utils.GetSupabase().GetProviderByIdWithResponse(ctx, ref, providerId)
	if err != nil {
		return err
	}

	if getResp.JSON200 == nil {
		if getResp.StatusCode() == http.StatusNotFound {
			return fmt.Errorf("An identity provider with ID %q could not be found.", providerId)
		}

		return errors.New("unexpected error fetching identity provider: " + string(getResp.Body))
	}

	putResp, err := utils.GetSupabase().UpdateProviderByIdWithResponse(ctx, ref, providerId, params)
	if err != nil {
		return err
	}

	if putResp.JSON200 == nil {
		return errors.New("unexpected error fetching identity provider: " + string(putResp.Body))
	}

	switch format {
	case utils.OutputPretty:
		return render.SingleMarkdown(api.Provider{
			Id:        putResp.JSON200.Id,
			Saml:      putResp.JSON200.Saml,
			Domains:   putResp.JSON200.Domains,
			CreatedAt: putResp.JSON200.CreatedAt,
			UpdatedAt: putResp.JSON200.UpdatedAt,
		})

	default:
		return utils.EncodeOutput(format, os.Stdout, putResp.JSON200)
	}
}
