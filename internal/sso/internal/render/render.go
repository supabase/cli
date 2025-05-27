package render

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/go-errors/errors"
	"github.com/go-xmlfmt/xmlfmt"
	"github.com/supabase/cli/internal/migration/list"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/api"
)

func formatProtocol(provider api.GetProviderResponse) string {
	protocol := "SAML 2.0"
	if provider.Saml == nil {
		protocol = "unknown"
	}

	return protocol
}

func formatMetadataSource(provider api.GetProviderResponse) string {
	source := "FILE"
	if provider.Saml != nil && provider.Saml.MetadataUrl != nil && *provider.Saml.MetadataUrl != "" {
		source = *provider.Saml.MetadataUrl
	}

	return source
}

func formatTimestamp(timestamp *string) string {
	if timestamp == nil {
		return ""
	}

	return utils.FormatTimestamp(*timestamp)
}

func formatDomains(provider api.GetProviderResponse) string {
	var domains []string

	if provider.Domains != nil {
		for _, domain := range *provider.Domains {
			if domain.Domain != nil {
				domains = append(domains, *domain.Domain)
			}
		}
	}

	domainsString := "-"
	if len(domains) > 0 {
		domainsString = strings.Join(domains, ", ")
	}

	return domainsString
}

func formatEntityID(provider api.GetProviderResponse) string {
	entityID := "-"
	if provider.Saml != nil && provider.Saml.EntityId != "" {
		entityID = provider.Saml.EntityId
	}

	return entityID
}

func ListMarkdown(providers api.ListProvidersResponse) error {
	markdownTable := []string{
		"|TYPE|IDENTITY PROVIDER ID|DOMAINS|SAML 2.0 `EntityID`|CREATED AT (UTC)|UPDATED AT (UTC)|\n|-|-|-|-|-|-|\n",
	}

	for _, item := range providers.Items {
		markdownTable = append(markdownTable, fmt.Sprintf(
			"|`%s`|`%s`|`%s`|`%s`|`%s`|`%s`|\n",
			formatProtocol(item),
			item.Id,
			formatDomains(item),
			formatEntityID(item),
			formatTimestamp(item.CreatedAt),
			formatTimestamp(item.UpdatedAt),
		))
	}

	return list.RenderTable(strings.Join(markdownTable, ""))
}

func SingleMarkdown(provider api.GetProviderResponse) error {
	markdownTable := []string{
		"|PROPERTY|VALUE|",
		"|-|-|",
	}

	markdownTable = append(markdownTable, fmt.Sprintf(
		"|IDENTITY PROVIDER ID|`%s`|",
		provider.Id,
	))

	markdownTable = append(markdownTable, fmt.Sprintf(
		"|TYPE|`%s`|",
		formatProtocol(provider),
	))

	markdownTable = append(markdownTable, fmt.Sprintf(
		"|DOMAINS|`%s`|",
		formatDomains(provider),
	))

	if provider.Saml != nil {
		markdownTable = append(markdownTable, fmt.Sprintf(
			"|SAML 2.0 METADATA|`%s`|",
			formatMetadataSource(provider),
		))

		markdownTable = append(markdownTable, fmt.Sprintf(
			"|SAML 2.0 `EntityID`|`%s`|",
			formatEntityID(provider),
		))
	}

	markdownTable = append(markdownTable, fmt.Sprintf(
		"|CREATED AT (UTC)|`%s`|",
		formatTimestamp(provider.CreatedAt),
	))

	markdownTable = append(markdownTable, fmt.Sprintf(
		"|UPDATED AT (UTC)|`%s`|",
		formatTimestamp(provider.CreatedAt),
	))

	if provider.Saml != nil && provider.Saml.AttributeMapping != nil && len(provider.Saml.AttributeMapping.Keys) > 0 {
		attributeMapping, err := json.MarshalIndent(provider.Saml.AttributeMapping, "", "  ")
		if err != nil {
			return errors.Errorf("failed to marshal attribute mapping: %w", err)
		}

		markdownTable = append(markdownTable, "", "## Attribute Mapping", "```json", string(attributeMapping), "```")
	}

	if provider.Saml != nil && provider.Saml.MetadataXml != nil && *provider.Saml.MetadataXml != "" {
		prettyXML := xmlfmt.FormatXML(*provider.Saml.MetadataXml, "  ", "  ")
		markdownTable = append(markdownTable, "", "## SAML 2.0 Metadata XML", "```xml", prettyXML, "```")
	}

	return list.RenderTable(strings.Join(markdownTable, "\n"))
}

func InfoMarkdown(ref string) error {
	markdownTable := []string{
		"|PROPERTY|VALUE|",
		"|-|-|",
	}

	markdownTable = append(markdownTable, fmt.Sprintf(
		"|Single sign-on URL (ACS URL) |`%s`|",
		fmt.Sprintf("https://%s.supabase.co/auth/v1/sso/saml/acs", ref),
	))

	markdownTable = append(markdownTable, fmt.Sprintf(
		"|Audience URI (SP Entity ID)|`%s`|",
		fmt.Sprintf("https://%s.supabase.co/auth/v1/sso/saml/metadata", ref),
	))

	markdownTable = append(markdownTable, fmt.Sprintf(
		"|Default Relay State|`%s`|",
		fmt.Sprintf("https://%s.supabase.co", ref),
	))

	return list.RenderTable(strings.Join(markdownTable, "\n"))
}
