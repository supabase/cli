package cmd

import (
	"strings"

	"github.com/spf13/cobra"
	"github.com/spf13/pflag"
	"github.com/spf13/viper"
)

// Passed from `-ldflags`: https://stackoverflow.com/q/11354518.
var version string

var rootCmd = &cobra.Command{
	Use:           "supabase",
	Short:         "Supabase CLI " + version,
	Version:       version,
	SilenceErrors: true,
	SilenceUsage:  true,
}

func Execute() {
	cobra.CheckErr(rootCmd.Execute())
}

func init() {
	cobra.OnInitialize(func() {
		viper.SetEnvPrefix("SUPABASE")
		viper.AutomaticEnv()
	})
	flags := rootCmd.PersistentFlags()
	flags.Bool("debug", false, "enable debug mode")
	flags.VisitAll(func(f *pflag.Flag) {
		viper.BindPFlag(strings.ReplaceAll(f.Name, "-", "_"), flags.Lookup(f.Name))
	})
	rootCmd.SetVersionTemplate("{{.Version}}\n")
}

// instantiate new rootCmd is a bit tricky with cobra, but it can be done later with the following
// approach for example: https://github.com/portworx/pxc/tree/master/cmd
func GetRootCmd() *cobra.Command {
	return rootCmd
}
