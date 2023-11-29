package cmd

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"strings"

	"github.com/mitchellh/mapstructure"
	"github.com/spf13/afero"
	"github.com/spf13/cobra"
	"github.com/spf13/viper"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/flags"
)

const (
	groupLocalDev      = "local-dev"
	groupManagementAPI = "management-api"
)

func IsManagementAPI(cmd *cobra.Command) bool {
	for cmd != cmd.Root() {
		if cmd.GroupID == groupManagementAPI {
			return true
		}
		// Find the last assigned group
		if len(cmd.GroupID) > 0 {
			break
		}
		cmd = cmd.Parent()
	}
	return false
}

func PromptLogin(ctx context.Context, fsys afero.Fs) error {
	if _, err := utils.LoadAccessTokenFS(fsys); err == utils.ErrMissingToken {
		utils.CmdSuggestion = fmt.Sprintf("Run %s first.", utils.Aqua("supabase login"))
		return errors.New("You need to be logged-in in order to use Management API commands.")
	} else {
		return err
	}
}

var experimental = []*cobra.Command{
	bansCmd,
	restrictionsCmd,
	vanityCmd,
	sslEnforcementCmd,
	genKeysCmd,
	postgresCmd,
	branchesCmd,
	storageCmd,
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
			// Change workdir
			fsys := afero.NewOsFs()
			if err := changeWorkDir(fsys); err != nil {
				return err
			}
			// Add common flags
			ctx := cmd.Context()
			if IsManagementAPI(cmd) {
				if err := PromptLogin(ctx, fsys); err != nil {
					return err
				}
				if cmd.Flags().Lookup("project-ref") != nil {
					if err := flags.ParseProjectRef(fsys); err != nil {
						return err
					}
				}
				ctx, _ = signal.NotifyContext(ctx, os.Interrupt)
			}
			if err := flags.ParseDatabaseConfig(cmd.Flags(), fsys); err != nil {
				return err
			}
			// Prepare context
			if viper.GetBool("DEBUG") {
				ctx = utils.WithTraceContext(ctx)
				fmt.Fprintln(os.Stderr, cmd.Root().Short)
			} else {
				utils.CmdSuggestion = utils.SuggestDebugFlag
			}
			cmd.SetContext(ctx)
			return nil
		},
		SilenceErrors: true,
	}
)

func Execute() {
	if err := rootCmd.Execute(); err != nil {
		fmt.Fprintln(os.Stderr, utils.Red(err.Error()))
		if len(utils.CmdSuggestion) > 0 {
			fmt.Fprintln(os.Stderr, utils.CmdSuggestion)
		}
		os.Exit(1)
	}
	if utils.CmdSuggestion != utils.SuggestDebugFlag {
		fmt.Fprintln(os.Stderr, utils.CmdSuggestion)
	}
}

func init() {
	cobra.OnInitialize(func() {
		// Allow overriding config object with automatic env
		// Ref: https://github.com/spf13/viper/issues/761
		envKeysMap := map[string]interface{}{}
		dec, err := mapstructure.NewDecoder(&mapstructure.DecoderConfig{
			Result:               &envKeysMap,
			IgnoreUntaggedFields: true,
		})
		cobra.CheckErr(err)
		cobra.CheckErr(dec.Decode(utils.Config))
		cobra.CheckErr(viper.MergeConfigMap(envKeysMap))
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

func changeWorkDir(fsys afero.Fs) error {
	workdir := viper.GetString("WORKDIR")
	if workdir == "" {
		var err error
		if workdir, err = utils.GetProjectRoot(fsys); err != nil {
			return err
		}
	}
	return os.Chdir(workdir)
}
