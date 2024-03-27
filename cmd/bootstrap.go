package cmd

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"strings"

	"github.com/spf13/afero"
	"github.com/spf13/cobra"
	"github.com/spf13/viper"
	"github.com/supabase/cli/internal/bootstrap"
	"github.com/supabase/cli/internal/utils"
)

var (
	templateUrl string

	bootstrapCmd = &cobra.Command{
		GroupID: groupQuickStart,
		Use:     "bootstrap [template]",
		Short:   "Bootstrap a Supabase project from a starter template",
		Args:    cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if !viper.IsSet("WORKDIR") {
				title := fmt.Sprintf("Enter a directory to bootstrap your project (or leave blank to use %s): ", utils.Bold(utils.CurrentDirAbs))
				workdir, err := utils.PromptText(title, os.Stdin)
				if err != nil {
					return err
				}
				viper.Set("WORKDIR", workdir)
			}
			ctx, _ := signal.NotifyContext(cmd.Context(), os.Interrupt)
			client := bootstrap.GetGtihubClient(ctx)
			templates, err := bootstrap.ListSamples(ctx, client)
			if err != nil {
				return err
			}
			if len(args) > 0 {
				name := strings.ToLower(args[0])
				for _, t := range templates {
					if t.Name == name {
						templateUrl = t.Url
					}
				}
			}
			if len(templateUrl) == 0 {
				if err := promptStarterTemplate(ctx, templates); err != nil {
					return err
				}
			}
			return bootstrap.Run(ctx, templateUrl, afero.NewOsFs())
		},
	}
)

func init() {
	bootstrapFlags := bootstrapCmd.Flags()
	bootstrapFlags.StringP("password", "p", "", "Password to your remote Postgres database.")
	cobra.CheckErr(viper.BindPFlag("DB_PASSWORD", bootstrapFlags.Lookup("password")))
	rootCmd.AddCommand(bootstrapCmd)
}

func promptStarterTemplate(ctx context.Context, templates []bootstrap.StarterTemplate) error {
	items := make([]utils.PromptItem, len(templates))
	for i, t := range templates {
		items[i] = utils.PromptItem{
			Index:   i,
			Summary: t.Name,
			Details: t.Description,
		}
	}
	title := "Which starter template do you want to use?"
	choice, err := utils.PromptChoice(ctx, title, items)
	if err != nil {
		return err
	}
	templateUrl = templates[choice.Index].Url
	return nil
}
