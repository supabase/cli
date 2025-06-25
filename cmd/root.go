package cmd

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strings"
	"time"

	"github.com/getsentry/sentry-go"
	"github.com/go-errors/errors"
	"github.com/spf13/afero"
	"github.com/spf13/cobra"
	"github.com/spf13/viper"
	"github.com/supabase/cli/internal/debug"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/flags"
	"golang.org/x/mod/semver"
)

const (
	groupQuickStart    = "quick-start"
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

func promptLogin(fsys afero.Fs) error {
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
	sentryOpts = sentry.ClientOptions{
		Dsn:        utils.SentryDsn,
		Release:    utils.Version,
		ServerName: "<redacted>",
		// Set TracesSampleRate to 1.0 to capture 100%
		// of transactions for performance monitoring.
		// We recommend adjusting this value in production,
		TracesSampleRate: 1.0,
	}

	createTicket bool

	rootCmd = &cobra.Command{
		Use:     "supabase",
		Short:   "Supabase CLI " + utils.Version,
		Version: utils.Version,
		PersistentPreRunE: func(cmd *cobra.Command, args []string) error {
			if IsExperimental(cmd) && !viper.GetBool("EXPERIMENTAL") {
				return errors.New("must set the --experimental flag to run this command")
			}
			cmd.SilenceUsage = true
			// Change workdir
			fsys := afero.NewOsFs()
			if err := utils.ChangeWorkDir(fsys); err != nil {
				return err
			}
			// Add common flags
			ctx := cmd.Context()
			if IsManagementAPI(cmd) {
				if err := promptLogin(fsys); err != nil {
					return err
				}
				ctx, _ = signal.NotifyContext(ctx, os.Interrupt)
				if cmd.Flags().Lookup("project-ref") != nil {
					if err := flags.ParseProjectRef(ctx, fsys); err != nil {
						return err
					}
				}
			}
			if err := flags.ParseDatabaseConfig(cmd.Flags(), fsys); err != nil {
				return err
			}
			// Prepare context
			if viper.GetBool("DEBUG") {
				http.DefaultTransport = debug.NewTransport()
				fmt.Fprintln(os.Stderr, cmd.Root().Short)
			}
			cmd.SetContext(ctx)
			// Setup sentry last to ignore errors from parsing cli flags
			apiHost, err := url.Parse(utils.GetSupabaseAPIHost())
			if err != nil {
				return err
			}
			sentryOpts.Environment = apiHost.Host
			return sentry.Init(sentryOpts)
		},
		SilenceErrors: true,
	}
)

func Execute() {
	defer recoverAndExit()
	if err := rootCmd.Execute(); err != nil {
		panic(err)
	}
	// Check upgrade last because --version flag is initialised after execute
	version, err := checkUpgrade(rootCmd.Context(), afero.NewOsFs())
	if err != nil {
		fmt.Fprintln(utils.GetDebugLogger(), err)
	}
	if semver.Compare(version, "v"+utils.Version) > 0 {
		fmt.Fprintln(os.Stderr, suggestUpgrade(version))
	}
	if len(utils.CmdSuggestion) > 0 {
		fmt.Fprintln(os.Stderr, utils.CmdSuggestion)
	}
}

func checkUpgrade(ctx context.Context, fsys afero.Fs) (string, error) {
	if shouldFetchRelease(fsys) {
		version, err := utils.GetLatestRelease(ctx)
		if exists, _ := afero.DirExists(fsys, utils.SupabaseDirPath); exists {
			// If user is offline, write an empty file to skip subsequent checks
			err = utils.WriteFile(utils.CliVersionPath, []byte(version), fsys)
		}
		return version, err
	}
	version, err := afero.ReadFile(fsys, utils.CliVersionPath)
	if err != nil {
		return "", errors.Errorf("failed to read cli version: %w", err)
	}
	return string(version), nil
}

func shouldFetchRelease(fsys afero.Fs) bool {
	// Always fetch latest release when using --version flag
	if vf := rootCmd.Flag("version"); vf != nil && vf.Changed {
		return true
	}
	if fi, err := fsys.Stat(utils.CliVersionPath); err == nil {
		expiry := fi.ModTime().Add(time.Hour * 10)
		// Skip if last checked is less than 10 hours ago
		return time.Now().After(expiry)
	}
	return true
}

func suggestUpgrade(version string) string {
	const guide = "https://supabase.com/docs/guides/cli/getting-started#updating-the-supabase-cli"
	return fmt.Sprintf(`A new version of Supabase CLI is available: %s (currently installed v%s)
We recommend updating regularly for new features and bug fixes: %s`, utils.Yellow(version), utils.Version, utils.Bold(guide))
}

func recoverAndExit() {
	err := recover()
	if err == nil {
		return
	}
	var msg string
	switch err := err.(type) {
	case string:
		msg = err
	case error:
		if !errors.Is(err, context.Canceled) &&
			len(utils.CmdSuggestion) == 0 &&
			!viper.GetBool("DEBUG") {
			utils.CmdSuggestion = utils.SuggestDebugFlag
		}
		if e, ok := err.(*errors.Error); ok && len(utils.Version) == 0 {
			fmt.Fprintln(os.Stderr, string(e.Stack()))
		}
		msg = err.Error()
	default:
		msg = fmt.Sprintf("%#v", err)
	}
	// Log error to console
	fmt.Fprintln(os.Stderr, utils.Red(msg))
	if len(utils.CmdSuggestion) > 0 {
		fmt.Fprintln(os.Stderr, utils.CmdSuggestion)
	}
	// Report error to sentry
	if createTicket && len(utils.SentryDsn) > 0 {
		sentry.ConfigureScope(addSentryScope)
		eventId := sentry.CurrentHub().Recover(err)
		if eventId != nil && sentry.Flush(2*time.Second) {
			fmt.Fprintln(os.Stderr, "Sent crash report:", *eventId)
			fmt.Fprintln(os.Stderr, "Quote the crash ID above when filing a bug report: https://github.com/supabase/cli/issues/new/choose")
		}
	}
	os.Exit(1)
}

func init() {
	cobra.OnInitialize(func() {
		viper.SetEnvPrefix("SUPABASE")
		viper.SetEnvKeyReplacer(strings.NewReplacer("-", "_"))
		viper.AutomaticEnv()
	})

	flags := rootCmd.PersistentFlags()
	flags.Bool("yes", false, "answer yes to all prompts")
	flags.Bool("debug", false, "output debug logs to stderr")
	flags.String("workdir", "", "path to a Supabase project directory")
	flags.Bool("experimental", false, "enable experimental features")
	flags.String("network-id", "", "use the specified docker network instead of a generated one")
	flags.VarP(&utils.OutputFormat, "output", "o", "output format of status variables")
	flags.Var(&utils.DNSResolver, "dns-resolver", "lookup domain names using the specified resolver")
	flags.BoolVar(&createTicket, "create-ticket", false, "create a support ticket for any CLI error")
	cobra.CheckErr(viper.BindPFlags(flags))

	rootCmd.SetVersionTemplate("{{.Version}}\n")
	rootCmd.AddGroup(&cobra.Group{ID: groupQuickStart, Title: "Quick Start:"})
	rootCmd.AddGroup(&cobra.Group{ID: groupLocalDev, Title: "Local Development:"})
	rootCmd.AddGroup(&cobra.Group{ID: groupManagementAPI, Title: "Management APIs:"})
}

// instantiate new rootCmd is a bit tricky with cobra, but it can be done later with the following
// approach for example: https://github.com/portworx/pxc/tree/master/cmd
func GetRootCmd() *cobra.Command {
	return rootCmd
}

func addSentryScope(scope *sentry.Scope) {
	serviceImages := utils.Config.GetServiceImages()
	imageToVersion := make(map[string]interface{}, len(serviceImages))
	for _, image := range serviceImages {
		parts := strings.Split(image, ":")
		// Bypasses sentry's IP sanitization rule, ie. 15.1.0.147
		if net.ParseIP(parts[1]) != nil {
			imageToVersion[parts[0]] = "v" + parts[1]
		} else {
			imageToVersion[parts[0]] = parts[1]
		}
	}
	scope.SetContext("Services", imageToVersion)
	scope.SetContext("Config", map[string]interface{}{
		"Image Registry": utils.GetRegistry(),
		"Project ID":     flags.ProjectRef,
	})
}
