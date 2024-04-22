package cmd

import (
	"github.com/spf13/cobra"

	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/hooks/trigger"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/flags"
)

var (
	triggerCmd = &cobra.Command{
		GroupID: groupManagementAPI,
		Use:     "trigger",
		Short:   "trigger an event payload",
	}

	someType = utils.EnumFlag{
		Allowed: []string{"send-email", "send-sms", "mfa-verification-attempt", "password-verification-attempt", "custom-acess-token"},
		// intentionally no default value so users have to specify --type saml explicitly
	}

	triggerRunCmd = &cobra.Command{
		Use:     "add",
		Short:   "triger a hook payload",
		Long:    "Trigger a mock payload to your local extensibility point. Currently only supports local",
		Example: `supabase hooks trigger --extension-point <name>`,
		RunE: func(cmd *cobra.Command, args []string) error {
			return create.Run(cmd.Context(), afero.NewOsFs(), create.RunParams{
				ProjectRef:     flags.ProjectRef,
				ExtensionPoint: someType.String(),
			})
		},
	}
)

func init() {
	persistentFlags := triggerCmd.PersistentFlags()
	persistentFlags.StringVar(&flags.ProjectRef, "project-ref", "", "Project ref of the Supabase project.")
	persistentFlags.VarP(&ssoOutput, "output", "o", "Output format")
	triggerRunFlags := triggerRunCmd.Flags()
	triggerRunFlags.VarP(&someType, "extension-point", "e", "Extension point")
	cobra.CheckErr(triggerRunCmd.MarkFlagRequired("extension-point"))

	triggerCmd.AddCommand(triggerRunCmd)

	rootCmd.AddCommand(triggerCmd)
}
