package cmd

import (
	"github.com/spf13/afero"
	"github.com/spf13/cobra"
	"github.com/supabase/cli/internal/functions/download"
	"github.com/supabase/cli/internal/utils/flags"
)

var (
	functionsCmd = &cobra.Command{
		GroupID: groupManagementAPI,
		Use:     "functions",
		Short:   "Manage Supabase Edge functions",
	}

	functionsDownloadCmd = &cobra.Command{
		Use:   "download [Function name]",
		Short: "Download a Function from Supabase",
		Long:  "Download the source code for a Function from the linked Supabase project. If no function name is provided, downloads all functions.",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if useApi {
				useDocker = false
			}
			slug := ""
			if len(args) > 0 {
				slug = args[0]
			}
			return download.Run(cmd.Context(), slug, flags.ProjectRef, useLegacyBundle, useDocker, afero.NewOsFs())
		},
	}

	useApi          bool
	useDocker       bool
	useLegacyBundle bool
)

func init() {
	downloadFlags := functionsDownloadCmd.Flags()
	downloadFlags.StringVar(&flags.ProjectRef, "project-ref", "", "Project ref of the Supabase project.")
	markFlagTelemetrySafe(downloadFlags.Lookup("project-ref"))
	downloadFlags.BoolVar(&useLegacyBundle, "legacy-bundle", false, "Use legacy bundling mechanism.")
	downloadFlags.BoolVar(&useApi, "use-api", false, "Unbundle functions server-side without using Docker.")
	downloadFlags.BoolVar(&useDocker, "use-docker", true, "Use Docker to unbundle functions client-side.")
	functionsDownloadCmd.MarkFlagsMutuallyExclusive("use-api", "use-docker", "legacy-bundle")
	cobra.CheckErr(downloadFlags.MarkHidden("legacy-bundle"))
	cobra.CheckErr(downloadFlags.MarkHidden("use-docker"))
	functionsCmd.AddCommand(functionsDownloadCmd)
	rootCmd.AddCommand(functionsCmd)
}
