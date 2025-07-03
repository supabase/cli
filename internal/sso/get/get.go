package get

import (
	"context"
	"fmt"
	"net/http"
	"os"

	"github.com/go-errors/errors"
	"github.com/google/uuid"
	"github.com/supabase/cli/internal/sso/internal/render"
	"github.com/supabase/cli/internal/utils"
)

func Run(ctx context.Context, ref, providerId, format string) error {
	parsed, err := uuid.Parse(providerId)
	if err != nil {
		return errors.Errorf("failed to parse provider id: %w", err)
	}
	resp, err := utils.GetSupabase().V1GetASsoProviderWithResponse(ctx, ref, parsed)
	if err != nil {
		return err
	}

	if resp.JSON200 == nil {
		if resp.StatusCode() == http.StatusNotFound {
			return errors.Errorf("An identity provider with ID %q could not be found.", providerId)
		}

		return errors.New("Unexpected error fetching identity provider: " + string(resp.Body))
	}

	switch format {
	case utils.OutputMetadata:
		_, err := fmt.Println(*resp.JSON200.Saml.MetadataXml)
		return err
	case utils.OutputPretty:
		return render.SingleMarkdown(*resp.JSON200)
	case utils.OutputEnv:
		return errors.Errorf("--output env flag is not supported")
	default:
		return utils.EncodeOutput(format, os.Stdout, resp.JSON200)
	}
}
