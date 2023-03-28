package create

import (
	"context"
	"errors"
	"net/http"
	"os"

	"github.com/supabase/cli/internal/sso/internal/render"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/api"
)

func Run(ctx context.Context, ref string, params api.CreateProviderBody, format string) error {
	resp, err := utils.GetSupabase().CreateProviderForProjectWithResponse(ctx, ref, params)
	if err != nil {
		return err
	}

	if resp.JSON201 == nil {
		if resp.StatusCode() == http.StatusNotFound {
			return errors.New("Looks like SAML 2.0 support is not enabled for this project. Please use the dashboard to enable it.")
		}

		return errors.New("Unexpected error adding identity provider: " + string(resp.Body))
	}

	switch format {
	case utils.OutputPretty:
		return render.SingleMarkdown(api.Provider{
			Id:        resp.JSON201.Id,
			Saml:      resp.JSON201.Saml,
			Domains:   resp.JSON201.Domains,
			CreatedAt: resp.JSON201.CreatedAt,
			UpdatedAt: resp.JSON201.UpdatedAt,
		})

	default:
		return utils.EncodeOutput(format, os.Stdout, resp.JSON201)
	}
}
