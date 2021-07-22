package cmd

import (
	"github.com/spf13/cobra"
)

var rootCmd = &cobra.Command{
	Use:           "supabase",
	Short:         "FIXME",
	Long:          `FIXME`,
	Version:       version,
	SilenceErrors: true,
	SilenceUsage:  true,
}

func Execute() {
	cobra.CheckErr(rootCmd.Execute())
}

func init() {
	rootCmd.SetVersionTemplate("{{.Version}}")
}
