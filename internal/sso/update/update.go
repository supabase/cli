package update

import (
	"context"
	"net/http"
	"os"

	"github.com/go-errors/errors"
	"github.com/google/uuid"
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
	parsed, err := uuid.Parse(params.ProviderID)
	if err != nil {
		return errors.Errorf("failed to parse provider ID: %w", err)
	}
	getResp, err := utils.GetSupabase().V1GetASsoProviderWithResponse(ctx, params.ProjectRef, parsed)
	if err != nil {
		return errors.Errorf("failed to get sso provider: %w", err)
	}

	if getResp.JSON200 == nil {
		if getResp.StatusCode() == http.StatusNotFound {
			return errors.Errorf("An identity provider with ID %q could not be found.", parsed)
		}

		return errors.New("unexpected error fetching identity provider: " + string(getResp.Body))
	}

	var body api.V1UpdateASsoProviderJSONRequestBody

	if params.MetadataFile != "" {
		data, err := saml.ReadMetadataFile(Fs, params.MetadataFile)
		if err != nil {
			return err
		}

		body.MetadataXml = &data
	} else if params.MetadataURL != "" {
		if !params.SkipURLValidation {
			if err := saml.ValidateMetadataURL(ctx, params.MetadataURL); err != nil {
				return errors.Errorf("%w Use --skip-url-validation to suppress this error.", err)
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

	if len(params.Domains) != 0 {
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

		domains := make([]string, 0)
		for domain := range domainsSet {
			domains = append(domains, domain)
		}

		body.Domains = &domains
	}

	putResp, err := utils.GetSupabase().V1UpdateASsoProviderWithResponse(ctx, params.ProjectRef, parsed, body)
	if err != nil {
		return errors.Errorf("failed to update sso provider: %w", err)
	}

	if putResp.JSON200 == nil {
		return errors.New("unexpected error fetching identity provider: " + string(putResp.Body))
	}

	switch params.Format {
	case utils.OutputPretty:
		return render.SingleMarkdown(api.GetProviderResponse(*putResp.JSON200))
	case utils.OutputEnv:
		return nil
	default:
		return utils.EncodeOutput(params.Format, os.Stdout, putResp.JSON200)
	}
}
