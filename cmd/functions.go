package cmd

import (
	"os"
	"os/signal"

	"github.com/spf13/afero"
	"github.com/spf13/cobra"
	"github.com/supabase/cli/internal/functions/delete"
	"github.com/supabase/cli/internal/functions/deploy"
	"github.com/supabase/cli/internal/functions/new"
	"github.com/supabase/cli/internal/functions/serve"
)

var (
	functionsCmd = &cobra.Command{
		Use:   "functions",
		Short: "Manage Supabase Edge functions",
	}

	functionsDeleteCmd = &cobra.Command{
		Use:   "delete <Function name>",
		Short: "Delete a Function from Supabase",
		Long:  "Delete a Function from the linked Supabase project. This does NOT remove the Function locally.",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			projectRef, err := cmd.Flags().GetString("project-ref")
			if err != nil {
				return err
			}

			return delete.Run(args[0], projectRef)
		},
	}

	functionsDeployCmd = &cobra.Command{
		Use:   "deploy <Function name>",
		Short: "Deploy a Function to Supabase",
		Long:  "Deploy a Function to the linked Supabase project.",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			noVerifyJWT, err := cmd.Flags().GetBool("no-verify-jwt")
			if err != nil {
				return err
			}
			projectRef, err := cmd.Flags().GetString("project-ref")
			if err != nil {
				return err
			}

			ctx, _ := signal.NotifyContext(cmd.Context(), os.Interrupt)
			return deploy.Run(ctx, args[0], projectRef, !noVerifyJWT, afero.NewOsFs())
		},
	}

	functionsNewCmd = &cobra.Command{
		Use:   "new <Function name>",
		Short: "Create a new Function locally",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return new.Run(args[0])
		},
	}

	functionsServeCmd = &cobra.Command{
		Use:   "serve <Function name>",
		Short: "Serve a Function locally",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			envFilePath, err := cmd.Flags().GetString("env-file")
			if err != nil {
				return err
			}
			noVerifyJWT, err := cmd.Flags().GetBool("no-verify-jwt")
			if err != nil {
				return err
			}

			return serve.Run(args[0], envFilePath, !noVerifyJWT)
		},
	}
)

func init() {
	functionsDeleteCmd.Flags().String("project-ref", "", "Project ref of the Supabase project.")
	functionsDeployCmd.Flags().Bool("no-verify-jwt", false, "Disable JWT verification for the Function.")
	functionsDeployCmd.Flags().String("project-ref", "", "Project ref of the Supabase project.")
	functionsServeCmd.Flags().Bool("no-verify-jwt", false, "Disable JWT verification for the Function.")
	functionsServeCmd.Flags().String("env-file", "", "Path to an env file to be populated to the Function environment.")
	functionsCmd.AddCommand(functionsDeleteCmd)
	functionsCmd.AddCommand(functionsDeployCmd)
	functionsCmd.AddCommand(functionsNewCmd)
	functionsCmd.AddCommand(functionsServeCmd)
	rootCmd.AddCommand(functionsCmd)
}
