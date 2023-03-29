package cmd

import (
	"errors"
	"fmt"
	"os"
	"os/signal"

	"github.com/spf13/afero"
	"github.com/spf13/cobra"

	"github.com/supabase/cli/internal/sso/create"
	"github.com/supabase/cli/internal/sso/get"
	"github.com/supabase/cli/internal/sso/info"
	"github.com/supabase/cli/internal/sso/list"
	"github.com/supabase/cli/internal/sso/remove"
	"github.com/supabase/cli/internal/sso/update"
	"github.com/supabase/cli/internal/utils"
)

var (
	ssoCmd = &cobra.Command{
		GroupID: groupManagementAPI,
		Use:     "sso",
		Short:   "Manage Single Sign-On (SSO) authentication for projects",
		PersistentPreRunE: func(cmd *cobra.Command, args []string) error {
			if err := cmd.Root().PersistentPreRunE(cmd, args); err != nil {
				return err
			}
			ctx, _ := signal.NotifyContext(cmd.Context(), os.Interrupt)
			cmd.SetContext(ctx)

			fsys := afero.NewOsFs()
			if err := PromptProjectRef(fsys, cmd); err != nil {
				return err
			}

			// Validate project ref
			if !utils.ProjectRefPattern.MatchString(projectRef) {
				return errors.New("Invalid project ref format. Must be like `abcdefghijklmnopqrst`.")
			}
			return nil
		},
	}

	ssoProviderType = utils.EnumFlag{
		Allowed: []string{"saml"},
		// intentionally no default value so users have to specify --type saml explicitly
	}
	ssoMetadataFile         string
	ssoMetadataURL          string
	ssoSkipURLValidation    bool
	ssoMetadata             bool
	ssoAttributeMappingFile string
	ssoDomains              []string
	ssoAddDomains           []string
	ssoRemoveDomains        []string
	ssoOutput               = utils.EnumFlag{
		Allowed: utils.OutputDefaultAllowed,
		Value:   utils.OutputPretty,
	}

	ssoAddCmd = &cobra.Command{
		Use:     "add",
		Short:   "Add a new SSO identity provider",
		Example: `  supabase sso add --type saml --project-ref mwjylndxudmiehsxhmmz --metadata-file ~/SAMLMetadata.xml --domains example.com`,
		RunE: func(cmd *cobra.Command, args []string) error {
			return create.Run(cmd.Context(), create.RunParams{
				ProjectRef: projectRef,
				Format:     ssoOutput.Value,

				MetadataFile:      ssoMetadataFile,
				MetadataURL:       ssoMetadataURL,
				SkipURLValidation: ssoSkipURLValidation,
				AttributeMapping:  ssoAttributeMappingFile,
				Domains:           ssoDomains,
			})
		},
	}

	ssoRemoveCmd = &cobra.Command{
		Use:     "remove <provider-id>",
		Short:   "Remove an existing SSO identity provider",
		Args:    cobra.ExactArgs(1),
		Example: `  supabase sso remove b5ae62f9-ef1d-4f11-a02b-731c8bbb11e8 --project-ref mwjylndxudmiehsxhmmz`,
		RunE: func(cmd *cobra.Command, args []string) error {
			if !utils.UUIDPattern.MatchString(args[0]) {
				return fmt.Errorf("Identity provider ID %q is not a UUID.", args[0])
			}

			return remove.Run(cmd.Context(), projectRef, args[0], ssoOutput.Value)
		},
	}

	ssoUpdateCmd = &cobra.Command{
		Use:     "update <provider-id>",
		Short:   "Update information about an SSO identity provider",
		Args:    cobra.ExactArgs(1),
		Example: `  supabase sso update b5ae62f9-ef1d-4f11-a02b-731c8bbb11e8 --project-ref mwjylndxudmiehsxhmmz --add-domain example.com`,
		RunE: func(cmd *cobra.Command, args []string) error {
			if !utils.UUIDPattern.MatchString(args[0]) {
				return fmt.Errorf("Identity provider ID %q is not a UUID.", args[0])
			}

			return update.Run(cmd.Context(), update.RunParams{
				ProjectRef: projectRef,
				ProviderID: args[0],
				Format:     ssoOutput.Value,

				MetadataFile:      ssoMetadataFile,
				MetadataURL:       ssoMetadataURL,
				SkipURLValidation: ssoSkipURLValidation,
				AttributeMapping:  ssoAttributeMappingFile,
				Domains:           ssoDomains,
				AddDomains:        ssoAddDomains,
				RemoveDomains:     ssoRemoveDomains,
			})
		},
	}

	ssoShowCmd = &cobra.Command{
		Use:     "show <provider-id>",
		Short:   "Show information about an SSO identity provider",
		Args:    cobra.ExactArgs(1),
		Example: `  supabase sso show b5ae62f9-ef1d-4f11-a02b-731c8bbb11e8 --project-ref mwjylndxudmiehsxhmmz`,
		RunE: func(cmd *cobra.Command, args []string) error {
			if !utils.UUIDPattern.MatchString(args[0]) {
				return fmt.Errorf("Identity provider ID %q is not a UUID.", args[0])
			}

			format := ssoOutput.Value
			if ssoMetadata {
				format = utils.OutputMetadata
			}

			return get.Run(cmd.Context(), projectRef, args[0], format)
		},
	}

	ssoListCmd = &cobra.Command{
		Use:     "list",
		Short:   "List all SSO identity providers for a project",
		Example: `  supabase sso list --project-ref mwjylndxudmiehsxhmmz`,
		RunE: func(cmd *cobra.Command, args []string) error {
			return list.Run(cmd.Context(), projectRef, ssoOutput.Value)
		},
	}

	ssoInfoCmd = &cobra.Command{
		Use:     "info",
		Short:   "Returns the SAML SSO settings required for the identity provider",
		Example: `  supabase sso info --project-ref mwjylndxudmiehsxhmmz`,
		RunE: func(cmd *cobra.Command, args []string) error {
			return info.Run(cmd.Context(), projectRef, ssoOutput.Value)
		},
	}
)

func init() {
	ssoAddFlags := ssoAddCmd.Flags()
	ssoAddFlags.VarP(&ssoProviderType, "type", "t", "Type of identity provider (according to supported protocol).")
	ssoAddFlags.VarP(&ssoOutput, "output", "o", "Output format")
	ssoAddFlags.StringVar(&projectRef, "project-ref", "", "Project on which to add this identity provider.")
	ssoAddFlags.StringSliceVar(&ssoDomains, "domains", nil, "Comma separated list of email domains to associate with the added identity provider.")
	ssoAddFlags.StringVar(&ssoMetadataFile, "metadata-file", "", "File containing a SAML 2.0 Metadata XML document describing the identity provider.")
	ssoAddFlags.StringVar(&ssoMetadataURL, "metadata-url", "", "URL pointing to a SAML 2.0 Metadata XML document describing the identity provider.")
	ssoAddFlags.BoolVar(&ssoSkipURLValidation, "skip-url-validation", false, "Whether local validation of the SAML 2.0 Metadata URL should not be performed.")
	ssoAddFlags.StringVar(&ssoAttributeMappingFile, "attribute-mapping-file", "", "File containing a JSON mapping between SAML attributes to custom JWT claims.")
	ssoAddCmd.MarkFlagsMutuallyExclusive("metadata-file", "metadata-url")
	cobra.CheckErr(ssoAddCmd.MarkFlagFilename("metadata-file", "xml"))
	cobra.CheckErr(ssoAddCmd.MarkFlagFilename("attribute-mapping-file", "json"))

	ssoRemoveFlags := ssoRemoveCmd.Flags()
	ssoRemoveFlags.VarP(&ssoOutput, "output", "o", "Output format")
	ssoRemoveFlags.StringVar(&projectRef, "project-ref", "", "Project on which to remove this identity provider.")

	ssoUpdateFlags := ssoUpdateCmd.Flags()
	ssoUpdateFlags.VarP(&ssoOutput, "output", "o", "Output format")
	ssoUpdateFlags.StringVar(&projectRef, "project-ref", "", "Project on which to update this identity provider.")
	ssoUpdateFlags.StringSliceVar(&ssoDomains, "domains", []string{}, "Replace domains with this comma separated list of email domains.")
	ssoUpdateFlags.StringSliceVar(&ssoAddDomains, "add-domains", []string{}, "Add this comma separated list of email domains to the identity provider.")
	ssoUpdateFlags.StringSliceVar(&ssoRemoveDomains, "remove-domains", []string{}, "Remove this comma separated list of email domains from the identity provider.")
	ssoUpdateFlags.StringVar(&ssoMetadataFile, "metadata-file", "", "File containing a SAML 2.0 Metadata XML document describing the identity provider.")
	ssoUpdateFlags.StringVar(&ssoMetadataURL, "metadata-url", "", "URL pointing to a SAML 2.0 Metadata XML document describing the identity provider.")
	ssoUpdateFlags.BoolVar(&ssoSkipURLValidation, "skip-url-validation", false, "Whether local validation of the SAML 2.0 Metadata URL should not be performed.")
	ssoUpdateFlags.StringVar(&ssoAttributeMappingFile, "attribute-mapping-file", "", "File containing a JSON mapping between SAML attributes to custom JWT claims.")
	ssoUpdateCmd.MarkFlagsMutuallyExclusive("metadata-file", "metadata-url")
	ssoUpdateCmd.MarkFlagsMutuallyExclusive("domains", "add-domains")
	ssoUpdateCmd.MarkFlagsMutuallyExclusive("domains", "remove-domains")
	cobra.CheckErr(ssoUpdateCmd.MarkFlagFilename("metadata-file", "xml"))
	cobra.CheckErr(ssoUpdateCmd.MarkFlagFilename("attribute-mapping-file", "json"))

	ssoShowFlags := ssoShowCmd.Flags()
	ssoShowFlags.VarP(&ssoOutput, "output", "o", "Output format")
	ssoShowFlags.StringVar(&projectRef, "project-ref", "", "Project on which to get this identity provider.")
	ssoShowFlags.BoolVar(&ssoMetadata, "metadata", false, "Show SAML 2.0 XML Metadata only")

	ssoListFlags := ssoListCmd.Flags()
	ssoListFlags.VarP(&ssoOutput, "output", "o", "Output format")
	ssoListFlags.StringVar(&projectRef, "project-ref", "", "Project on which to list identity providers.")

	ssoInfoFlags := ssoInfoCmd.Flags()
	ssoInfoFlags.VarP(&ssoOutput, "output", "o", "Output format")
	ssoInfoFlags.StringVar(&projectRef, "project-ref", "", "Project on which to show project SAML SSO settings.")

	ssoCmd.AddCommand(ssoAddCmd)
	ssoCmd.AddCommand(ssoRemoveCmd)
	ssoCmd.AddCommand(ssoUpdateCmd)
	ssoCmd.AddCommand(ssoShowCmd)
	ssoCmd.AddCommand(ssoListCmd)
	ssoCmd.AddCommand(ssoInfoCmd)

	rootCmd.AddCommand(ssoCmd)
}
