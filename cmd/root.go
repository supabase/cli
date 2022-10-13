package cmd

import (
	"os"
	"strings"

	"github.com/spf13/afero"
	"github.com/spf13/cobra"
	"github.com/spf13/pflag"
	"github.com/spf13/viper"
	"github.com/supabase/cli/internal/utils"
)

// Passed from `-ldflags`: https://stackoverflow.com/q/11354518.
var version string

var rootCmd = &cobra.Command{
	Use:           "supabase",
	Short:         "Supabase CLI " + version,
	Version:       version,
	SilenceErrors: true,
	SilenceUsage:  true,
	PersistentPreRunE: func(cmd *cobra.Command, args []string) error {
		if viper.GetBool("DEBUG") {
			cmd.SetContext(utils.WithTraceContext(cmd.Context()))
		}

		workdir := viper.GetString("WORKDIR")
		if workdir == "" {
			var err error
			if workdir, err = utils.GetProjectRoot(afero.NewOsFs()); err != nil {
				return err
			}
		}
		return os.Chdir(workdir)
	},
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

	flags.Bool("debug", false, "output debug logs to stderr")
	flags.String("workdir", "", "path to a Supabase project directory")

	flags.VisitAll(func(f *pflag.Flag) {
		key := strings.ReplaceAll(f.Name, "-", "_")
		cobra.CheckErr(viper.BindPFlag(key, flags.Lookup(f.Name)))
	})
	rootCmd.SetVersionTemplate("{{.Version}}\n")
}

// instantiate new rootCmd is a bit tricky with cobra, but it can be done later with the following
// approach for example: https://github.com/portworx/pxc/tree/master/cmd
func GetRootCmd() *cobra.Command {
	return rootCmd
}
