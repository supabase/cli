package cmd

import (
	"fmt"

	"github.com/go-errors/errors"
	"github.com/spf13/afero"
	"github.com/spf13/cobra"
	"github.com/supabase/cli/internal/functions/delete"
	"github.com/supabase/cli/internal/functions/deploy"
	"github.com/supabase/cli/internal/functions/download"
	"github.com/supabase/cli/internal/functions/list"
	new_ "github.com/supabase/cli/internal/functions/new"
	"github.com/supabase/cli/internal/functions/serve"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/flags"
	"github.com/supabase/cli/pkg/cast"
)

var (
	functionsCmd = &cobra.Command{
		GroupID: groupManagementAPI,
		Use:     "functions",
		Short:   "Manage Supabase Edge functions",
	}

	functionsListCmd = &cobra.Command{
		Use:   "list",
		Short: "List all Functions in Supabase",
		Long:  "List all Functions in the linked Supabase project.",
		RunE: func(cmd *cobra.Command, args []string) error {
			return list.Run(cmd.Context(), flags.ProjectRef, afero.NewOsFs())
		},
	}

	functionsDeleteCmd = &cobra.Command{
		Use:   "delete <Function name>",
		Short: "Delete a Function from Supabase",
		Long:  "Delete a Function from the linked Supabase project. This does NOT remove the Function locally.",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return delete.Run(cmd.Context(), args[0], flags.ProjectRef, afero.NewOsFs())
		},
	}

	functionsDownloadCmd = &cobra.Command{
		Use:   "download <Function name>",
		Short: "Download a Function from Supabase",
		Long:  "Download the source code for a Function from the linked Supabase project.",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return download.Run(cmd.Context(), args[0], flags.ProjectRef, useLegacyBundle, afero.NewOsFs())
		},
	}

	useApi          bool
	useDocker       bool
	useLegacyBundle bool
	noVerifyJWT     = new(bool)
	importMapPath   string
	prune           bool

	functionsDeployCmd = &cobra.Command{
		Use:   "deploy [Function name]",
		Short: "Deploy a Function to Supabase",
		Long:  "Deploy a Function to the linked Supabase project.",
		RunE: func(cmd *cobra.Command, args []string) error {
			// Fallback to config if user did not set the flag.
			if !cmd.Flags().Changed("no-verify-jwt") {
				noVerifyJWT = nil
			}
			if useApi {
				useDocker = false
			} else if maxJobs > 1 {
				return errors.New("--jobs must be used together with --use-api")
			}
			return deploy.Run(cmd.Context(), args, useDocker, noVerifyJWT, importMapPath, maxJobs, prune, afero.NewOsFs())
		},
	}

	functionsNewCmd = &cobra.Command{
		Use:   "new <Function name>",
		Short: "Create a new Function locally",
		Args:  cobra.ExactArgs(1),
		PersistentPreRunE: func(cmd *cobra.Command, args []string) error {
			cmd.GroupID = groupLocalDev
			return cmd.Root().PersistentPreRunE(cmd, args)
		},
		RunE: func(cmd *cobra.Command, args []string) error {
			return new_.Run(cmd.Context(), args[0], afero.NewOsFs())
		},
	}

	envFilePath string
	inspectBrk  bool
	inspectMode = utils.EnumFlag{
		Allowed: []string{
			string(serve.InspectModeRun),
			string(serve.InspectModeBrk),
			string(serve.InspectModeWait),
		},
	}
	runtimeOption serve.RuntimeOption

	functionsServeCmd = &cobra.Command{
		Use:   "serve",
		Short: "Serve all Functions locally",
		PersistentPreRunE: func(cmd *cobra.Command, args []string) error {
			cmd.GroupID = groupLocalDev
			return cmd.Root().PersistentPreRunE(cmd, args)
		},
		RunE: func(cmd *cobra.Command, args []string) error {
			// Fallback to config if user did not set the flag.
			if !cmd.Flags().Changed("no-verify-jwt") {
				noVerifyJWT = nil
			}

			if len(inspectMode.Value) > 0 {
				runtimeOption.InspectMode = cast.Ptr(serve.InspectMode(inspectMode.Value))
			} else if inspectBrk {
				runtimeOption.InspectMode = cast.Ptr(serve.InspectModeBrk)
			}
			if runtimeOption.InspectMode == nil && runtimeOption.InspectMain {
				return fmt.Errorf("--inspect-main must be used together with one of these flags: [inspect inspect-mode]")
			}

			return serve.Run(cmd.Context(), envFilePath, noVerifyJWT, importMapPath, runtimeOption, afero.NewOsFs())
		},
	}
)

func init() {
	functionsListCmd.Flags().StringVar(&flags.ProjectRef, "project-ref", "", "Project ref of the Supabase project.")
	functionsDeleteCmd.Flags().StringVar(&flags.ProjectRef, "project-ref", "", "Project ref of the Supabase project.")
	deployFlags := functionsDeployCmd.Flags()
	deployFlags.BoolVar(&useApi, "use-api", false, "Use Management API to bundle functions.")
	deployFlags.BoolVar(&useDocker, "use-docker", true, "Use Docker to bundle functions.")
	deployFlags.BoolVar(&useLegacyBundle, "legacy-bundle", false, "Use legacy bundling mechanism.")
	functionsDeployCmd.MarkFlagsMutuallyExclusive("use-api", "use-docker", "legacy-bundle")
	cobra.CheckErr(deployFlags.MarkHidden("legacy-bundle"))
	deployFlags.UintVarP(&maxJobs, "jobs", "j", 1, "Maximum number of parallel jobs.")
	deployFlags.BoolVar(noVerifyJWT, "no-verify-jwt", false, "Disable JWT verification for the Function.")
	deployFlags.BoolVar(&prune, "prune", false, "Delete Functions that exist in Supabase project but not locally.")
	deployFlags.StringVar(&flags.ProjectRef, "project-ref", "", "Project ref of the Supabase project.")
	deployFlags.StringVar(&importMapPath, "import-map", "", "Path to import map file.")
	functionsServeCmd.Flags().BoolVar(noVerifyJWT, "no-verify-jwt", false, "Disable JWT verification for the Function.")
	functionsServeCmd.Flags().StringVar(&envFilePath, "env-file", "", "Path to an env file to be populated to the Function environment.")
	functionsServeCmd.Flags().StringVar(&importMapPath, "import-map", "", "Path to import map file.")
	functionsServeCmd.Flags().BoolVar(&inspectBrk, "inspect", false, "Alias of --inspect-mode brk.")
	functionsServeCmd.Flags().Var(&inspectMode, "inspect-mode", "Activate inspector capability for debugging.")
	functionsServeCmd.Flags().BoolVar(&runtimeOption.InspectMain, "inspect-main", false, "Allow inspecting the main worker.")
	functionsServeCmd.MarkFlagsMutuallyExclusive("inspect", "inspect-mode")
	functionsServeCmd.Flags().Bool("all", true, "Serve all Functions.")
	cobra.CheckErr(functionsServeCmd.Flags().MarkHidden("all"))
	functionsDownloadCmd.Flags().StringVar(&flags.ProjectRef, "project-ref", "", "Project ref of the Supabase project.")
	functionsDownloadCmd.Flags().BoolVar(&useLegacyBundle, "legacy-bundle", false, "Use legacy bundling mechanism.")
	functionsCmd.AddCommand(functionsListCmd)
	functionsCmd.AddCommand(functionsDeleteCmd)
	functionsCmd.AddCommand(functionsDeployCmd)
	functionsCmd.AddCommand(functionsNewCmd)
	functionsCmd.AddCommand(functionsServeCmd)
	functionsCmd.AddCommand(functionsDownloadCmd)
	rootCmd.AddCommand(functionsCmd)
}
