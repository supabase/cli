package cmd

import (
	"github.com/spf13/cobra"
	"github.com/supabase/cli/internal/functions/delete"
	"github.com/supabase/cli/internal/functions/deploy"
	"github.com/supabase/cli/internal/functions/new"
	"github.com/supabase/cli/internal/functions/serve"
)

var (
	functionsCmd = &cobra.Command{
		Use:   "functions",
		Short: "Supabase Functions",
	}

	functionsDeleteCmd = &cobra.Command{
		Use:   "delete <Function name>",
		Short: "Delete a Function from the linked Supabase project. This does NOT remove the Function locally.",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return delete.Run(args[0])
		},
	}

	functionsDeployCmd = &cobra.Command{
		Use:   "deploy <Function name>",
		Short: "Deploy a Function to the linked Supabase project.",
		Args:  cobra.RangeArgs(1, 2),
		RunE: func(cmd *cobra.Command, args []string) error {
			projectRef, err := cmd.Flags().GetString("project-ref")
			if err != nil {
				return err
			}
			return deploy.Run(args[0], projectRef)
		},
	}

	functionsNewCmd = &cobra.Command{
		Use:   "new <Function name>",
		Short: "Create a new Function locally.",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return new.Run(args[0])
		},
	}

	functionsServeCmd = &cobra.Command{
		Use:   "serve <Function name>",
		Short: "Serve a Function locally.",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			envFilePath, err := cmd.Flags().GetString("env-file")
			if err != nil {
				return err
			}

			return serve.Run(envFilePath, args[0])
		},
	}
)

func init() {
	functionsServeCmd.Flags().String("env-file", "", "Path to an env file to be populated to the Function environment")
	functionsDeployCmd.Flags().String("project-ref", "", "Project ref of the Supabase project")
	functionsCmd.AddCommand(functionsDeleteCmd)
	functionsCmd.AddCommand(functionsDeployCmd)
	functionsCmd.AddCommand(functionsNewCmd)
	functionsCmd.AddCommand(functionsServeCmd)
	rootCmd.AddCommand(functionsCmd)
}
