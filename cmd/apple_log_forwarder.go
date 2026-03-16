package cmd

import (
	"github.com/spf13/cobra"
	"github.com/supabase/cli/internal/utils"
)

var (
	appleLogForwarderContainer string
	appleLogForwarderOutput    string

	appleLogForwarderCmd = &cobra.Command{
		Use:    "apple-log-forwarder",
		Short:  "Internal Apple analytics log forwarder",
		Hidden: true,
		RunE: func(cmd *cobra.Command, args []string) error {
			return utils.RunAppleAnalyticsLogForwarder(cmd.Context(), appleLogForwarderContainer, appleLogForwarderOutput)
		},
	}
)

func init() {
	flags := appleLogForwarderCmd.Flags()
	flags.StringVar(&appleLogForwarderContainer, "container", "", "container id to follow")
	flags.StringVar(&appleLogForwarderOutput, "output", "", "output path for JSONL logs")
	cobra.CheckErr(appleLogForwarderCmd.MarkFlagRequired("container"))
	cobra.CheckErr(appleLogForwarderCmd.MarkFlagRequired("output"))
	rootCmd.AddCommand(appleLogForwarderCmd)
}
