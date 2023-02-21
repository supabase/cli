package cmd

import (
	"github.com/spf13/cobra"
)

var (
	ssoCmd = &cobra.Command{
		GroupID: groupManagementAPI,
		Use:     "sso",
		Short:   "Manage Single Sign-On (SSO) authentication for projects",
	}

	ssoProjectRef           string
	ssoMetadataFile         string
	ssoMetadataURL          string
	ssoAttributeMappingFile string
	ssoDomains              []string
	ssoAddDomains           []string
	ssoRemoveDomains        []string

	ssoAddCmd = &cobra.Command{
		Use:     "add <type> [flags]",
		Short:   "Add a new SSO identity provider",
		Args:    cobra.ExactArgs(1),
		Example: `  supabase sso add saml --project-ref abcdefghijklmn --metadata-file ~/SAMLMetadata.xml`,
		PreRun: func(cmd *cobra.Command, args []string) {
			cobra.CheckErr(cmd.MarkFlagRequired("project-ref"))
		},
		RunE: func(cmd *cobra.Command, args []string) error {
			return nil
		},
	}

	ssoRemoveCmd = &cobra.Command{
		Use:     "remove <provider-id> [flags]",
		Short:   "Remove an existing SSO identity provider",
		Args:    cobra.ExactArgs(1),
		Example: `  supabase sso remove b5ae62f9-ef1d-4f11-a02b-731c8bbb11e8 --project-ref abcdefghijklmn`,
		PreRun: func(cmd *cobra.Command, args []string) {
			cobra.CheckErr(cmd.MarkFlagRequired("project-ref"))
		},
		RunE: func(cmd *cobra.Command, args []string) error {
			return nil
		},
	}

	ssoUpdateCmd = &cobra.Command{
		Use:     "update <provider-id> [flags]",
		Short:   "Update information about an SSO identity provider",
		Args:    cobra.ExactArgs(1),
		Example: `  supabase sso update b5ae62f9-ef1d-4f11-a02b-731c8bbb11e8 --project-ref abcdefghijklmn --add-domain example.com`,
		PreRun: func(cmd *cobra.Command, args []string) {
			cobra.CheckErr(cmd.MarkFlagRequired("project-ref"))
		},
		RunE: func(cmd *cobra.Command, args []string) error {
			return nil
		},
	}

	ssoGetCmd = &cobra.Command{
		Use:     "get <provider-id> [flags]",
		Short:   "Get information about an SSO identity provider",
		Args:    cobra.ExactArgs(1),
		Example: `  supabase sso get b5ae62f9-ef1d-4f11-a02b-731c8bbb11e8 --project-ref abcdefghijklmn`,
		PreRun: func(cmd *cobra.Command, args []string) {
			cobra.CheckErr(cmd.MarkFlagRequired("project-ref"))
		},
		RunE: func(cmd *cobra.Command, args []string) error {
			return nil
		},
	}

	ssoListCmd = &cobra.Command{
		Use:     "list",
		Short:   "List all SSO identity providers for a project",
		Example: `  supabase sso list --project-ref b5ae62f9-ef1d-4f11-a02b-731c8bbb11e8`,
		PreRun: func(cmd *cobra.Command, args []string) {
			cobra.CheckErr(cmd.MarkFlagRequired("project-ref"))
		},
		RunE: func(cmd *cobra.Command, args []string) error {
			return nil
		},
	}
)

func init() {
	ssoAddFlags := ssoAddCmd.Flags()
	ssoAddFlags.StringVar(&ssoProjectRef, "project-ref", "", "Project on which to add this identity provider.")
	ssoAddFlags.StringSliceVar(&ssoDomains, "domains", nil, "Comma separated list of email domains to associate with the added identity provider.")
	ssoAddFlags.StringVar(&ssoMetadataFile, "metadata-file", "", "File containing a SAML 2.0 Metadata XML document describing the identity provider.")
	ssoAddFlags.StringVar(&ssoMetadataURL, "metadata-url", "", "URL pointing to a SAML 2.0 Metadata XML document describing the identity provider.")
	ssoAddFlags.StringVar(&ssoAttributeMappingFile, "attribute-mapping-file", "", "File containing a JSON mapping between SAML attributes to custom JWT claims.")
	ssoAddCmd.MarkFlagsMutuallyExclusive("metadata-file", "metadata-url")
	cobra.CheckErr(ssoAddCmd.MarkFlagFilename("metadata-file", "xml"))
	cobra.CheckErr(ssoAddCmd.MarkFlagFilename("attribute-mapping-file", "json"))

	ssoRemoveFlags := ssoRemoveCmd.Flags()
	ssoRemoveFlags.StringVar(&ssoProjectRef, "project-ref", "", "Project on which to remove this identity provider.")

	ssoUpdateFlags := ssoUpdateCmd.Flags()
	ssoUpdateFlags.StringVar(&ssoProjectRef, "project-ref", "", "Project on which to update this identity provider.")
	ssoUpdateFlags.StringSliceVar(&ssoDomains, "domains", []string{}, "Replace domains with this comma separated list of email domains.")
	ssoUpdateFlags.StringSliceVar(&ssoAddDomains, "add-domains", []string{}, "Add this comma separated list of email domains to the identity provider.")
	ssoUpdateFlags.StringSliceVar(&ssoRemoveDomains, "remove-domains", []string{}, "Remove this comma separated list of email domains from the identity provider.")
	ssoUpdateFlags.StringVar(&ssoMetadataFile, "metadata-file", "", "File containing a SAML 2.0 Metadata XML document describing the identity provider.")
	ssoUpdateFlags.StringVar(&ssoMetadataURL, "metadata-url", "", "URL pointing to a SAML 2.0 Metadata XML document describing the identity provider.")
	ssoUpdateFlags.StringVar(&ssoAttributeMappingFile, "attribute-mapping-file", "", "File containing a JSON mapping between SAML attributes to custom JWT claims.")
	ssoUpdateCmd.MarkFlagsMutuallyExclusive("metadata-file", "metadata-url")
	ssoUpdateCmd.MarkFlagsMutuallyExclusive("domains", "add-domains")
	ssoUpdateCmd.MarkFlagsMutuallyExclusive("domains", "remove-domains")
	cobra.CheckErr(ssoUpdateCmd.MarkFlagFilename("metadata-file", "xml"))
	cobra.CheckErr(ssoUpdateCmd.MarkFlagFilename("attribute-mapping-file", "json"))

	ssoGetFlags := ssoGetCmd.Flags()
	ssoGetFlags.StringVar(&ssoProjectRef, "project-ref", "", "Project on which to get this identity provider.")

	ssoListFlags := ssoListCmd.Flags()
	ssoListFlags.StringVar(&ssoProjectRef, "project-ref", "", "Project on which to list identity providers.")

	ssoCmd.AddCommand(ssoAddCmd)
	ssoCmd.AddCommand(ssoRemoveCmd)
	ssoCmd.AddCommand(ssoUpdateCmd)
	ssoCmd.AddCommand(ssoGetCmd)
	ssoCmd.AddCommand(ssoListCmd)

	rootCmd.AddCommand(ssoCmd)
}
