package cmd

import (
	"fmt"
	"os"
	"strings"

	"github.com/spf13/afero"
	"github.com/spf13/cobra"
	"github.com/spf13/pflag"
	"github.com/spf13/viper"
	"github.com/supabase/cli/internal/utils"
)

var (
	// Passed from `-ldflags`: https://stackoverflow.com/q/11354518.
	version      string
	experimental bool
	suggestion   string
)

var rootCmd = &cobra.Command{
	Use:     "supabase",
	Short:   "Supabase CLI " + version,
	Version: version,
	PersistentPreRunE: func(cmd *cobra.Command, args []string) error {
		cmd.SilenceUsage = true
		if viper.GetBool("DEBUG") {
			cmd.SetContext(utils.WithTraceContext(cmd.Context()))
		} else {
			suggestion = "Try rerunning the command with --debug to troubleshoot the error."
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
	if err := rootCmd.Execute(); err != nil {
		if len(suggestion) > 0 {
			fmt.Fprintln(os.Stderr, suggestion)
		}
		os.Exit(1)
	}
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

	flags.BoolVar(&experimental, "experimental", false, "enable experimental features")

	rootCmd.SetVersionTemplate("{{.Version}}\n")
	rootCmd.AddGroup(&cobra.Group{ID: "local-dev", Title: "Local Development:"})
	rootCmd.AddGroup(&cobra.Group{ID: "management-api", Title: "Management APIs:"})
}

// instantiate new rootCmd is a bit tricky with cobra, but it can be done later with the following
// approach for example: https://github.com/portworx/pxc/tree/master/cmd
func GetRootCmd() *cobra.Command {
	return rootCmd
}
