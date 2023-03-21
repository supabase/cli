package cmd

import (
	"errors"
	"fmt"
	"log"
	"os"
	"strings"

	"github.com/mitchellh/mapstructure"
	"github.com/spf13/afero"
	"github.com/spf13/cobra"
	"github.com/spf13/viper"
	"github.com/supabase/cli/internal/utils"
)

const (
	groupLocalDev      = "local-dev"
	groupManagementAPI = "management-api"
)

var experimental = []*cobra.Command{
	bansCmd,
	restrictionsCmd,
	vanityCmd,
	sslEnforcementCmd,
}

func IsExperimental(cmd *cobra.Command) bool {
	for _, exp := range experimental {
		if cmd == exp || cmd.Parent() == exp {
			return true
		}
	}
	return false
}

var (
	rootCmd = &cobra.Command{
		Use:     "supabase",
		Short:   "Supabase CLI " + utils.Version,
		Version: utils.Version,
		PersistentPreRunE: func(cmd *cobra.Command, args []string) error {
			if IsExperimental(cmd) && !viper.GetBool("experimental") {
				return errors.New("must set the --experimental flag to run this command")
			}
			cmd.SilenceUsage = true
			if viper.GetBool("DEBUG") {
				cmd.SetContext(utils.WithTraceContext(cmd.Context()))
			} else {
				utils.CmdSuggestion = "Try rerunning the command with --debug to troubleshoot the error."
			}
			// Set workdir
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
)

func Execute() {
	if err := rootCmd.Execute(); err != nil {
		if len(utils.CmdSuggestion) > 0 {
			fmt.Fprintln(os.Stderr, utils.CmdSuggestion)
		}
		os.Exit(1)
	}
}

func init() {
	cobra.OnInitialize(func() {
		// Allow overriding config with automatic env
		envKeysMap := map[string]interface{}{}
		if dec, err := mapstructure.NewDecoder(&mapstructure.DecoderConfig{
			Result:               &envKeysMap,
			IgnoreUntaggedFields: true,
		}); err != nil {
			log.Fatalln(err)
		} else if err := dec.Decode(utils.Config); err != nil {
			log.Fatalln(err)
		}
		if err := viper.MergeConfigMap(envKeysMap); err != nil {
			log.Fatalln(err)
		}
		viper.SetEnvPrefix("SUPABASE")
		viper.SetEnvKeyReplacer(strings.NewReplacer("-", "_", ".", "_"))
		viper.AutomaticEnv()
	})

	flags := rootCmd.PersistentFlags()
	flags.Bool("debug", false, "output debug logs to stderr")
	flags.String("workdir", "", "path to a Supabase project directory")
	flags.Bool("experimental", false, "enable experimental features")
	flags.Var(&utils.DNSResolver, "dns-resolver", "lookup domain names using the specified resolver")
	cobra.CheckErr(viper.BindPFlags(flags))

	rootCmd.SetVersionTemplate("{{.Version}}\n")
	rootCmd.AddGroup(&cobra.Group{ID: groupLocalDev, Title: "Local Development:"})
	rootCmd.AddGroup(&cobra.Group{ID: groupManagementAPI, Title: "Management APIs:"})
}

// instantiate new rootCmd is a bit tricky with cobra, but it can be done later with the following
// approach for example: https://github.com/portworx/pxc/tree/master/cmd
func GetRootCmd() *cobra.Command {
	return rootCmd
}
