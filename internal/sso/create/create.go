package create

import (
	"context"
	"net/http"
	"os"

	"github.com/go-errors/errors"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/sso/internal/render"
	"github.com/supabase/cli/internal/sso/internal/saml"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/api"
)

var Fs = afero.NewOsFs()

type RunParams struct {
	ProjectRef string
	Format     string

	Type              string
	Domains           []string
	MetadataFile      string
	MetadataURL       string
	SkipURLValidation bool
	AttributeMapping  string
}

func Run(ctx context.Context, params RunParams) error {
	var body api.V1CreateASsoProviderJSONRequestBody
	body.Type = api.CreateProviderBodyType(params.Type)

	if params.MetadataFile != "" {
		data, err := saml.ReadMetadataFile(Fs, params.MetadataFile)
		if err != nil {
			return err
		}

		body.MetadataXml = &data
	} else if params.MetadataURL != "" {
		if !params.SkipURLValidation {
			if err := saml.ValidateMetadataURL(ctx, params.MetadataURL); err != nil {
				return errors.Errorf("%w Use --skip-url-validation to suppress this error", err)
			}
		}

		body.MetadataUrl = &params.MetadataURL
	}

	if params.AttributeMapping != "" {
		body.AttributeMapping = &struct {
			Keys map[string]struct {
				Array   *bool        "json:\"array,omitempty\""
				Default *interface{} "json:\"default,omitempty\""
				Name    *string      "json:\"name,omitempty\""
				Names   *[]string    "json:\"names,omitempty\""
			} "json:\"keys\""
		}{}
		if err := saml.ReadAttributeMappingFile(Fs, params.AttributeMapping, body.AttributeMapping); err != nil {
			return err
		}
	}

	if params.Domains != nil {
		body.Domains = &params.Domains
	}

	resp, err := utils.GetSupabase().V1CreateASsoProviderWithResponse(ctx, params.ProjectRef, body)
	if err != nil {
		return errors.Errorf("failed to create sso provider: %w", err)
	}

	if resp.JSON201 == nil {
		if resp.StatusCode() == http.StatusNotFound {
			return errors.New("SAML 2.0 support is not enabled for this project. Please enable it through the dashboard")
		}

		return errors.New("Unexpected error adding identity provider: " + string(resp.Body))
	}

	switch params.Format {
	case utils.OutputPretty:
		return render.SingleMarkdown(api.GetProviderResponse(*resp.JSON201))
	case utils.OutputEnv:
		return nil
	default:
		return utils.EncodeOutput(params.Format, os.Stdout, resp.JSON201)
	}
}
