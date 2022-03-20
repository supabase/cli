package cmd

import (
	"github.com/spf13/cobra"
	"github.com/supabase/cli/internal/functions/deploy"
	"github.com/supabase/cli/internal/functions/new"
)

var (
	functionsCmd = &cobra.Command{
		Use:   "functions",
		Short: "Supabase Functions",
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
)

func init() {
	functionsCmd.AddCommand(functionsDeployCmd)
	functionsCmd.AddCommand(functionsNewCmd)
	rootCmd.AddCommand(functionsCmd)
}
