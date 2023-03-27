package render

import (
	"fmt"
	"strings"
	"time"

	"github.com/charmbracelet/glamour"
	"github.com/go-xmlfmt/xmlfmt"
	"github.com/supabase/cli/pkg/api"
)

func formatProtocol(provider api.Provider) string {
	protocol := "SAML 2.0"
	if provider.Saml == nil || *provider.Saml == (api.SamlDescriptor{}) {
		protocol = "unknown"
	}

	return protocol
}

func formatMetadataSource(provider api.Provider) string {
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

	t, err := time.Parse(time.RFC3339, *timestamp)

	if err != nil {
		return *timestamp
	}

	return t.UTC().Format("2006-01-02 15:04:05")
}

func formatDomains(provider api.Provider) string {
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

func formatEntityID(provider api.Provider) string {
	entityID := "-"
	if provider.Saml != nil && provider.Saml.EntityId != "" {
		entityID = provider.Saml.EntityId
	}

	return entityID
}

func ListMarkdown(providers []api.Provider) error {
	markdownTable := []string{
		"|TYPE|IDENTITY PROVIDER ID|DOMAINS|SAML 2.0 `EntityID`|CREATED AT (UTC)|UPDATED AT (UTC)|\n|-|-|-|-|-|-|\n",
	}

	for _, item := range providers {
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

	r, err := glamour.NewTermRenderer(
		glamour.WithAutoStyle(),
		glamour.WithWordWrap(-1),
	)
	if err != nil {
		return err
	}

	out, err := r.Render(strings.Join(markdownTable, ""))
	if err != nil {
		return err
	}

	fmt.Print(out)
	return nil
}

func SingleMarkdown(provider api.Provider) error {
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

	if provider.Saml != nil && provider.Saml.MetadataXml != nil && *provider.Saml.MetadataXml != "" {
		prettyXML := xmlfmt.FormatXML(*provider.Saml.MetadataXml, "  ", "  ")
		markdownTable = append(markdownTable, "", "## SAML 2.0 Metadata XML", "```xml", prettyXML, "```")
	}

	r, err := glamour.NewTermRenderer(
		glamour.WithAutoStyle(),
		glamour.WithWordWrap(-1),
	)
	if err != nil {
		return err
	}

	out, err := r.Render(strings.Join(markdownTable, "\n"))
	if err != nil {
		return err
	}

	fmt.Print(out)
	return nil
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
		"|Default Relaystate|`%s`|",
		fmt.Sprintf("https://%s.supabase.co", ref),
	))

	r, err := glamour.NewTermRenderer(
		glamour.WithAutoStyle(),
		glamour.WithWordWrap(-1),
	)
	if err != nil {
		return err
	}

	out, err := r.Render(strings.Join(markdownTable, "\n"))
	if err != nil {
		return err
	}

	fmt.Print(out)
	return nil
}
