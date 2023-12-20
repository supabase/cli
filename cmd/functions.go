package cmd

import (
	"github.com/spf13/afero"
	"github.com/spf13/cobra"
	"github.com/supabase/cli/internal/functions/delete"
	"github.com/supabase/cli/internal/functions/deploy"
	"github.com/supabase/cli/internal/functions/download"
	"github.com/supabase/cli/internal/functions/list"
	new_ "github.com/supabase/cli/internal/functions/new"
	"github.com/supabase/cli/internal/functions/serve"
	"github.com/supabase/cli/internal/utils/flags"
)

var (
	functionsCmd = &cobra.Command{
		GroupID: groupManagementAPI,
		Use:     "functions",
		Short:   "Manage Supabase Edge functions",
	}

	functionsListCmd = &cobra.Command{
		Use:   "list",
		Short: "List all Functions in Supabase",
		Long:  "List all Functions in the linked Supabase project.",
		RunE: func(cmd *cobra.Command, args []string) error {
			return list.Run(cmd.Context(), flags.ProjectRef, afero.NewOsFs())
		},
	}

	functionsDeleteCmd = &cobra.Command{
		Use:   "delete <Function name>",
		Short: "Delete a Function from Supabase",
		Long:  "Delete a Function from the linked Supabase project. This does NOT remove the Function locally.",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return delete.Run(cmd.Context(), args[0], flags.ProjectRef, afero.NewOsFs())
		},
	}

	functionsDownloadCmd = &cobra.Command{
		Use:   "download <Function name>",
		Short: "Download a Function from Supabase",
		Long:  "Download the source code for a Function from the linked Supabase project.",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return download.Run(cmd.Context(), args[0], flags.ProjectRef, useLegacyBundle, afero.NewOsFs())
		},
	}

	noVerifyJWT     = new(bool)
	useLegacyBundle bool
	importMapPath   string

	functionsDeployCmd = &cobra.Command{
		Use:   "deploy [Function name]",
		Short: "Deploy a Function to Supabase",
		Long:  "Deploy a Function to the linked Supabase project.",
		RunE: func(cmd *cobra.Command, args []string) error {
			// Fallback to config if user did not set the flag.
			if !cmd.Flags().Changed("no-verify-jwt") {
				noVerifyJWT = nil
			}
			return deploy.Run(cmd.Context(), args, flags.ProjectRef, noVerifyJWT, importMapPath, afero.NewOsFs())
		},
	}

	functionsNewCmd = &cobra.Command{
		Use:   "new <Function name>",
		Short: "Create a new Function locally",
		Args:  cobra.ExactArgs(1),
		PersistentPreRunE: func(cmd *cobra.Command, args []string) error {
			cmd.GroupID = groupLocalDev
			return cmd.Root().PersistentPreRunE(cmd, args)
		},
		RunE: func(cmd *cobra.Command, args []string) error {
			return new_.Run(cmd.Context(), args[0], afero.NewOsFs())
		},
	}

	envFilePath string

	functionsServeCmd = &cobra.Command{
		Use:   "serve",
		Short: "Serve all Functions locally",
		PersistentPreRunE: func(cmd *cobra.Command, args []string) error {
			cmd.GroupID = groupLocalDev
			return cmd.Root().PersistentPreRunE(cmd, args)
		},
		RunE: func(cmd *cobra.Command, args []string) error {
			// Fallback to config if user did not set the flag.
			if !cmd.Flags().Changed("no-verify-jwt") {
				noVerifyJWT = nil
			}
			return serve.Run(cmd.Context(), envFilePath, noVerifyJWT, importMapPath, afero.NewOsFs())
		},
	}
)

func init() {
	functionsListCmd.Flags().StringVar(&flags.ProjectRef, "project-ref", "", "Project ref of the Supabase project.")
	functionsDeleteCmd.Flags().StringVar(&flags.ProjectRef, "project-ref", "", "Project ref of the Supabase project.")
	functionsDeployCmd.Flags().BoolVar(noVerifyJWT, "no-verify-jwt", false, "Disable JWT verification for the Function.")
	functionsDeployCmd.Flags().StringVar(&flags.ProjectRef, "project-ref", "", "Project ref of the Supabase project.")
	functionsDeployCmd.Flags().BoolVar(&useLegacyBundle, "legacy-bundle", false, "Use legacy bundling mechanism.")
	functionsDeployCmd.Flags().StringVar(&importMapPath, "import-map", "", "Path to import map file.")
	cobra.CheckErr(functionsDeployCmd.Flags().MarkHidden("legacy-bundle"))
	functionsServeCmd.Flags().BoolVar(noVerifyJWT, "no-verify-jwt", false, "Disable JWT verification for the Function.")
	functionsServeCmd.Flags().StringVar(&envFilePath, "env-file", "", "Path to an env file to be populated to the Function environment.")
	functionsServeCmd.Flags().StringVar(&importMapPath, "import-map", "", "Path to import map file.")
	functionsServeCmd.Flags().Bool("all", true, "Serve all Functions")
	cobra.CheckErr(functionsServeCmd.Flags().MarkHidden("all"))
	functionsDownloadCmd.Flags().StringVar(&flags.ProjectRef, "project-ref", "", "Project ref of the Supabase project.")
	functionsDownloadCmd.Flags().BoolVar(&useLegacyBundle, "legacy-bundle", false, "Use legacy bundling mechanism.")
	functionsCmd.AddCommand(functionsListCmd)
	functionsCmd.AddCommand(functionsDeleteCmd)
	functionsCmd.AddCommand(functionsDeployCmd)
	functionsCmd.AddCommand(functionsNewCmd)
	functionsCmd.AddCommand(functionsServeCmd)
	functionsCmd.AddCommand(functionsDownloadCmd)
	rootCmd.AddCommand(functionsCmd)
}
