package update

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
	ProviderID string
	Format     string

	MetadataFile      string
	MetadataURL       string
	SkipURLValidation bool
	AttributeMapping  string

	Domains       []string
	AddDomains    []string
	RemoveDomains []string
}

func Run(ctx context.Context, params RunParams) error {
	getResp, err := utils.GetSupabase().GetProviderByIdWithResponse(ctx, params.ProjectRef, params.ProviderID)
	if err != nil {
		return err
	}

	if getResp.JSON200 == nil {
		if getResp.StatusCode() == http.StatusNotFound {
			return fmt.Errorf("An identity provider with ID %q could not be found.", params.ProviderID)
		}

		return errors.New("unexpected error fetching identity provider: " + string(getResp.Body))
	}

	var body api.UpdateProviderByIdJSONRequestBody

	if params.MetadataFile != "" {
		data, err := saml.ReadMetadataFile(Fs, params.MetadataFile)
		if err != nil {
			return err
		}

		body.MetadataXml = &data
	} else if params.MetadataURL != "" {
		if !params.SkipURLValidation {
			if err := saml.ValidateMetadataURL(ctx, params.MetadataURL); err != nil {
				return fmt.Errorf("%w Use --skip-url-validation to suppress this error.", err)
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
	} else if params.AddDomains != nil || params.RemoveDomains != nil {
		domainsSet := make(map[string]bool)

		if getResp.JSON200.Domains != nil {
			for _, domain := range *getResp.JSON200.Domains {
				if domain.Domain != nil {
					domainsSet[*domain.Domain] = true
				}
			}
		}

		for _, rmDomain := range params.RemoveDomains {
			delete(domainsSet, rmDomain)
		}

		for _, addDomain := range params.AddDomains {
			domainsSet[addDomain] = true
		}

		var domains []string
		for domain := range domainsSet {
			domains = append(domains, domain)
		}

		body.Domains = &domains
	}

	putResp, err := utils.GetSupabase().UpdateProviderByIdWithResponse(ctx, params.ProjectRef, params.ProviderID, body)
	if err != nil {
		return err
	}

	if putResp.JSON200 == nil {
		return errors.New("unexpected error fetching identity provider: " + string(putResp.Body))
	}

	switch params.Format {
	case utils.OutputPretty:
		return render.SingleMarkdown(api.Provider{
			Id:        putResp.JSON200.Id,
			Saml:      putResp.JSON200.Saml,
			Domains:   putResp.JSON200.Domains,
			CreatedAt: putResp.JSON200.CreatedAt,
			UpdatedAt: putResp.JSON200.UpdatedAt,
		})

	default:
		return utils.EncodeOutput(params.Format, os.Stdout, putResp.JSON200)
	}
}
