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
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return deploy.Run(args[0])
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
			return serve.Run(args[0])
		},
	}
)

func init() {
	functionsCmd.AddCommand(functionsDeleteCmd)
	functionsCmd.AddCommand(functionsDeployCmd)
	functionsCmd.AddCommand(functionsNewCmd)
	functionsCmd.AddCommand(functionsServeCmd)
	rootCmd.AddCommand(functionsCmd)
}
