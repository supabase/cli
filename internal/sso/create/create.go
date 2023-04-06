package create

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"

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
	var body api.CreateProviderForProjectJSONRequestBody
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
				return fmt.Errorf("%w Use --skip-url-validation to suppress this error", err)
			}
		}

		body.MetadataUrl = &params.MetadataURL
	}

	if params.AttributeMapping != "" {
		data, err := saml.ReadAttributeMappingFile(Fs, params.AttributeMapping)
		if err != nil {
			return err
		}

		body.AttributeMapping = data
	}

	if params.Domains != nil {
		body.Domains = &params.Domains
	}

	resp, err := utils.GetSupabase().CreateProviderForProjectWithResponse(ctx, params.ProjectRef, body)
	if err != nil {
		return err
	}

	if resp.JSON201 == nil {
		if resp.StatusCode() == http.StatusNotFound {
			return errors.New("SAML 2.0 support is not enabled for this project. Please enable it through the dashboard")
		}

		return errors.New("Unexpected error adding identity provider: " + string(resp.Body))
	}

	switch params.Format {
	case utils.OutputPretty:
		return render.SingleMarkdown(api.Provider{
			Id:        resp.JSON201.Id,
			Saml:      resp.JSON201.Saml,
			Domains:   resp.JSON201.Domains,
			CreatedAt: resp.JSON201.CreatedAt,
			UpdatedAt: resp.JSON201.UpdatedAt,
		})

	default:
		return utils.EncodeOutput(params.Format, os.Stdout, resp.JSON201)
	}
}
