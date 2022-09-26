package cmd

import (
	"bufio"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"strings"

	"github.com/spf13/afero"
	"github.com/spf13/cobra"
	"github.com/supabase/cli/internal/functions/delete"
	"github.com/supabase/cli/internal/functions/deploy"
	"github.com/supabase/cli/internal/functions/new"
	"github.com/supabase/cli/internal/functions/serve"
	"github.com/supabase/cli/internal/login"
	"github.com/supabase/cli/internal/utils"
)

var (
	functionsCmd = &cobra.Command{
		Use:   "functions",
		Short: "Manage Supabase Edge functions",
	}

	projectRef string

	functionsDeleteCmd = &cobra.Command{
		Use:   "delete <Function name>",
		Short: "Delete a Function from Supabase",
		Long:  "Delete a Function from the linked Supabase project. This does NOT remove the Function locally.",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			fsys := afero.NewOsFs()
			if err := PromptLogin(fsys); err != nil {
				return err
			}
			ctx, _ := signal.NotifyContext(cmd.Context(), os.Interrupt)
			return delete.Run(ctx, args[0], projectRef, fsys)
		},
	}

	noVerifyJWT bool

	functionsDeployCmd = &cobra.Command{
		Use:   "deploy <Function name>",
		Short: "Deploy a Function to Supabase",
		Long:  "Deploy a Function to the linked Supabase project.",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			fsys := afero.NewOsFs()
			if err := PromptLogin(fsys); err != nil {
				return err
			}
			if err := PromptProjectRef(fsys); err != nil {
				return err
			}
			ctx, _ := signal.NotifyContext(cmd.Context(), os.Interrupt)
			return deploy.Run(ctx, args[0], projectRef, !noVerifyJWT, fsys)
		},
	}

	functionsNewCmd = &cobra.Command{
		Use:   "new <Function name>",
		Short: "Create a new Function locally",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx, _ := signal.NotifyContext(cmd.Context(), os.Interrupt)
			return new.Run(ctx, args[0], afero.NewOsFs())
		},
	}

	envFilePath string

	functionsServeCmd = &cobra.Command{
		Use:   "serve <Function name>",
		Short: "Serve a Function locally",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx, _ := signal.NotifyContext(cmd.Context(), os.Interrupt)
			return serve.Run(ctx, args[0], envFilePath, !noVerifyJWT, afero.NewOsFs())
		},
	}
)

func init() {
	functionsDeleteCmd.Flags().StringVar(&projectRef, "project-ref", "", "Project ref of the Supabase project.")
	functionsDeployCmd.Flags().BoolVar(&noVerifyJWT, "no-verify-jwt", false, "Disable JWT verification for the Function.")
	functionsServeCmd.Flags().BoolVar(&noVerifyJWT, "no-verify-jwt", false, "Disable JWT verification for the Function.")
	functionsServeCmd.Flags().StringVar(&envFilePath, "env-file", "", "Path to an env file to be populated to the Function environment.")
	functionsCmd.AddCommand(functionsDeleteCmd)
	functionsCmd.AddCommand(functionsDeployCmd)
	functionsCmd.AddCommand(functionsNewCmd)
	functionsCmd.AddCommand(functionsServeCmd)
	rootCmd.AddCommand(functionsCmd)
}

func PromptLogin(fsys afero.Fs) error {
	if _, err := utils.LoadAccessTokenFS(fsys); err == nil {
		return nil
	} else if strings.HasPrefix(err.Error(), "Access token not provided. Supply an access token by running") {
		return login.Run(os.Stdin, fsys)
	} else {
		return err
	}
}

func PromptProjectRef(fsys afero.Fs) error {
	if len(projectRef) > 0 {
		return nil
	} else if err := utils.AssertIsLinkedFS(fsys); err == nil {
		return nil
	} else if strings.HasPrefix(err.Error(), "Cannot find project ref. Have you run") {
		fmt.Printf(`You can find your project ref from the project's dashboard home page, e.g. %s/project/<project-ref>.
Enter your project ref: `, utils.GetSupabaseDashboardURL())

		scanner := bufio.NewScanner(os.Stdin)
		if !scanner.Scan() {
			return errors.New("Cancelled " + utils.Aqua("supabase functions deploy") + ".")
		}

		projectRef = strings.TrimSpace(scanner.Text())
		return nil
	} else {
		return err
	}
}
