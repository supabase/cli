package cmd

import (
	"github.com/spf13/afero"
	"github.com/spf13/cobra"
	"github.com/supabase/cli/internal/utils/flags"
	"github.com/supabase/cli/internal/vanity_subdomains/activate"
	"github.com/supabase/cli/internal/vanity_subdomains/check"
	"github.com/supabase/cli/internal/vanity_subdomains/delete"
	"github.com/supabase/cli/internal/vanity_subdomains/get"
)

var (
	vanityCmd = &cobra.Command{
		GroupID: groupManagementAPI,
		Use:     "vanity-subdomains",
		Short:   "Manage vanity subdomains for Supabase projects",
		Long: `Manage vanity subdomains for Supabase projects.

Usage of vanity subdomains and custom domains is mutually exclusive.`,
	}

	desiredSubdomain string

	vanityActivateCmd = &cobra.Command{
		Use:   "activate",
		Short: "Activate a vanity subdomain",
		Long: `Activate a vanity subdomain for your Supabase project.

This reconfigures your Supabase project to respond to requests on your vanity subdomain.
After the vanity subdomain is activated, your project's auth services will no longer function on the {project-ref}.{supabase-domain} hostname.
`,
		RunE: func(cmd *cobra.Command, args []string) error {
			return activate.Run(cmd.Context(), flags.ProjectRef, desiredSubdomain, afero.NewOsFs())
		},
	}

	vanityGetCmd = &cobra.Command{
		Use:   "get",
		Short: "Get the current vanity subdomain",
		RunE: func(cmd *cobra.Command, args []string) error {
			return get.Run(cmd.Context(), flags.ProjectRef, afero.NewOsFs())
		},
	}

	vanityCheckCmd = &cobra.Command{
		Use:   "check-availability",
		Short: "Checks if a desired subdomain is available for use",
		RunE: func(cmd *cobra.Command, args []string) error {
			return check.Run(cmd.Context(), flags.ProjectRef, desiredSubdomain, afero.NewOsFs())
		},
	}

	vanityDeleteCmd = &cobra.Command{
		Use:   "delete",
		Short: "Deletes a project's vanity subdomain",
		Long:  `Deletes the vanity subdomain for a project, and reverts to using the project ref for routing.`,
		RunE: func(cmd *cobra.Command, args []string) error {
			return delete.Run(cmd.Context(), flags.ProjectRef, afero.NewOsFs())
		},
	}
)

func init() {
	vanityCmd.PersistentFlags().StringVar(&flags.ProjectRef, "project-ref", "", "Project ref of the Supabase project.")
	vanityActivateCmd.Flags().StringVar(&desiredSubdomain, "desired-subdomain", "", "The desired vanity subdomain to use for your Supabase project.")
	vanityCheckCmd.Flags().StringVar(&desiredSubdomain, "desired-subdomain", "", "The desired vanity subdomain to use for your Supabase project.")
	vanityCmd.AddCommand(vanityGetCmd)
	vanityCmd.AddCommand(vanityCheckCmd)
	vanityCmd.AddCommand(vanityActivateCmd)
	vanityCmd.AddCommand(vanityDeleteCmd)

	rootCmd.AddCommand(vanityCmd)
}
