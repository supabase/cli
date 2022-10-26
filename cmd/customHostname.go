package cmd

import (
	"errors"
	"os"
	"os/signal"

	"github.com/spf13/afero"
	"github.com/spf13/cobra"
	"github.com/supabase/cli/internal/hostnames/activate"
	"github.com/supabase/cli/internal/hostnames/create"
	"github.com/supabase/cli/internal/hostnames/delete"
	"github.com/supabase/cli/internal/hostnames/get"
	"github.com/supabase/cli/internal/hostnames/reverify"
)

var (
	customHostnamesCmd = &cobra.Command{
		Use:   "custom-hostname",
		Short: "Manage custom hostnames for Supabase projects",
		PersistentPreRunE: func(cmd *cobra.Command, args []string) error {
			if !experimental {
				return errors.New("must set the --experimental flag to run this command")
			}
			return nil
		},
	}

	rawOutput      bool
	customHostname string

	customHostnamesCreateCmd = &cobra.Command{
		Use:   "create",
		Short: "Create a custom hostname.",
		Long: `Create a custom hostname for your Supabase project.

Expects your custom hostname to have a CNAME record to your Supabase project's subdomain.`,
		RunE: func(cmd *cobra.Command, args []string) error {
			fsys := afero.NewOsFs()
			if err := PromptLogin(fsys); err != nil {
				return err
			}
			ctx, _ := signal.NotifyContext(cmd.Context(), os.Interrupt)
			return create.Run(ctx, projectRef, customHostname, rawOutput, fsys)
		},
	}

	customHostnamesGetCmd = &cobra.Command{
		Use:   "get",
		Short: "Get the current custom hostname config.",
		Long:  "Retrieve the custom hostname config for your project, as stored in the Supabase platform.",
		RunE: func(cmd *cobra.Command, args []string) error {
			fsys := afero.NewOsFs()
			if err := PromptLogin(fsys); err != nil {
				return err
			}
			ctx, _ := signal.NotifyContext(cmd.Context(), os.Interrupt)
			return get.Run(ctx, projectRef, rawOutput, fsys)
		},
	}

	customHostnamesReverifyCmd = &cobra.Command{
		Use:   "reverify",
		Short: "Re-verify the custom hostname config for your project.",
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx, _ := signal.NotifyContext(cmd.Context(), os.Interrupt)
			return reverify.Run(ctx, projectRef, rawOutput, afero.NewOsFs())
		},
	}

	customHostnamesActivateCmd = &cobra.Command{
		Use:   "activate",
		Short: "Activate the custom hostname for a project.",
		Long: `Activates the custom hostname configuration for a project.

This reconfigures your Supabase project to respond to requests on your custom hostname.
After the custom hostname is activated, your project's auth services will no longer function on the Supabase-provisioned subdomain.`,
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx, _ := signal.NotifyContext(cmd.Context(), os.Interrupt)
			return activate.Run(ctx, projectRef, rawOutput, afero.NewOsFs())
		},
	}

	customHostnamesDeleteCmd = &cobra.Command{
		Use:   "delete",
		Short: "Deletes the custom hostname config for your project.",
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx, _ := signal.NotifyContext(cmd.Context(), os.Interrupt)
			return delete.Run(ctx, projectRef, afero.NewOsFs())
		},
	}
)

func init() {
	customHostnamesCmd.PersistentFlags().StringVar(&projectRef, "project-ref", "", "Project ref of the Supabase project.")
	customHostnamesCmd.PersistentFlags().BoolVar(&rawOutput, "include-raw-output", false, "Include raw output (useful for debugging).")
	customHostnamesCreateCmd.Flags().StringVar(&customHostname, "custom-hostname", "", "The custom hostname to use for your Supabase project.")
	customHostnamesCmd.AddCommand(customHostnamesGetCmd)
	customHostnamesCmd.AddCommand(customHostnamesCreateCmd)
	customHostnamesCmd.AddCommand(customHostnamesReverifyCmd)
	customHostnamesCmd.AddCommand(customHostnamesActivateCmd)
	customHostnamesCmd.AddCommand(customHostnamesDeleteCmd)

	rootCmd.AddCommand(customHostnamesCmd)
}
