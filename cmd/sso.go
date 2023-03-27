package cmd

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/signal"
	"strings"
	"unicode/utf8"

	"github.com/spf13/afero"
	"github.com/spf13/cobra"

	"github.com/supabase/cli/internal/sso/create"
	"github.com/supabase/cli/internal/sso/get"
	"github.com/supabase/cli/internal/sso/info"
	"github.com/supabase/cli/internal/sso/list"
	"github.com/supabase/cli/internal/sso/remove"
	"github.com/supabase/cli/internal/sso/update"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/api"
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

	ssoMetadataFile         string
	ssoMetadataURL          string
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
		Use:     "add <type = saml> [flags]",
		Short:   "Add a new SSO identity provider",
		Args:    cobra.ExactArgs(1),
		Example: `  supabase sso add saml --project-ref mwjylndxudmiehsxhmmz --metadata-file ~/SAMLMetadata.xml`,
		RunE: func(cmd *cobra.Command, args []string) error {
			var params api.CreateProviderForProjectJSONRequestBody

			switch strings.ToLower(args[0]) {
			case "saml":
				params.Type = api.Saml

			default:
				return errors.New("type must be saml")
			}

			fsys := afero.NewOsFs()

			if ssoMetadataFile != "" {
				data, err := readMetadataFile(fsys, ssoMetadataFile)
				if err != nil {
					return err
				}

				params.MetadataXml = &data
			} else if ssoMetadataURL != "" {
				// TODO: fetch and validate Metadata
				params.MetadataUrl = &ssoMetadataURL
			} else {
				return errors.New("--metadata-file or --metadata-url must be provided")
			}

			if ssoAttributeMappingFile != "" {
				mapping, err := readAttributeMappingFile(fsys, ssoAttributeMappingFile)
				if err != nil {
					return err
				}

				params.AttributeMapping = mapping
			}

			params.Domains = &ssoDomains

			return create.Run(cmd.Context(), projectRef, params, ssoOutput.Value)
		},
	}

	ssoRemoveCmd = &cobra.Command{
		Use:     "remove <provider-id> [flags]",
		Short:   "Remove an existing SSO identity provider",
		Args:    cobra.ExactArgs(1),
		Example: `  supabase sso remove b5ae62f9-ef1d-4f11-a02b-731c8bbb11e8 --project-ref mwjylndxudmiehsxhmmz`,
		RunE: func(cmd *cobra.Command, args []string) error {
			return remove.Run(cmd.Context(), projectRef, args[0], ssoOutput.Value)
		},
	}

	ssoUpdateCmd = &cobra.Command{
		Use:     "update <provider-id> [flags]",
		Short:   "Update information about an SSO identity provider",
		Args:    cobra.ExactArgs(1),
		Example: `  supabase sso update b5ae62f9-ef1d-4f11-a02b-731c8bbb11e8 --project-ref mwjylndxudmiehsxhmmz --add-domain example.com`,
		RunE: func(cmd *cobra.Command, args []string) error {
			var params api.UpdateProviderByIdJSONRequestBody

			fsys := afero.NewOsFs()

			if ssoMetadataFile != "" {
				data, err := readMetadataFile(fsys, ssoMetadataFile)
				if err != nil {
					return err
				}

				params.MetadataXml = &data
			} else if ssoMetadataURL != "" {
				// TODO: fetch and validate Metadata
				params.MetadataUrl = &ssoMetadataURL
			}

			if ssoAttributeMappingFile != "" {
				mapping, err := readAttributeMappingFile(fsys, ssoAttributeMappingFile)
				if err != nil {
					return err
				}

				params.AttributeMapping = mapping
			}

			params.Domains = &ssoDomains

			return update.Run(cmd.Context(), projectRef, args[0], params, ssoAddDomains, ssoRemoveDomains, ssoOutput.Value)
		},
	}

	ssoShowCmd = &cobra.Command{
		Use:     "show <provider-id> [flags]",
		Short:   "Show information about an SSO identity provider",
		Args:    cobra.ExactArgs(1),
		Example: `  supabase sso show b5ae62f9-ef1d-4f11-a02b-731c8bbb11e8 --project-ref mwjylndxudmiehsxhmmz`,
		RunE: func(cmd *cobra.Command, args []string) error {
			format := ssoOutput.Value
			if ssoMetadata {
				format = "metadata"
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
	ssoAddFlags.VarP(&ssoOutput, "output", "o", "Output format")
	ssoAddFlags.StringVar(&projectRef, "project-ref", "", "Project on which to add this identity provider.")
	ssoAddFlags.StringSliceVar(&ssoDomains, "domains", nil, "Comma separated list of email domains to associate with the added identity provider.")
	ssoAddFlags.StringVar(&ssoMetadataFile, "metadata-file", "", "File containing a SAML 2.0 Metadata XML document describing the identity provider.")
	ssoAddFlags.StringVar(&ssoMetadataURL, "metadata-url", "", "URL pointing to a SAML 2.0 Metadata XML document describing the identity provider.")
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

func readMetadataFile(fsys afero.Fs, path string) (string, error) {
	file, err := fsys.Open(path)
	if err != nil {
		return "", err
	}

	data, err := io.ReadAll(file)
	if err != nil {
		return "", err
	}

	if !utf8.Valid(data) {
		return "", fmt.Errorf("SAML Metadata XML at %q is not UTF-8 encoded: %w", path, err)
	}

	return string(data), nil
}

func readAttributeMappingFile(fsys afero.Fs, path string) (*api.AttributeMapping, error) {
	file, err := fsys.Open(path)
	if err != nil {
		return nil, err
	}

	data, err := io.ReadAll(file)
	if err != nil {
		return nil, err
	}

	var mapping *api.AttributeMapping

	if err := json.Unmarshal(data, mapping); err != nil {
		return nil, err
	}

	return mapping, nil
}
