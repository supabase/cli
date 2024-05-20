package cmd

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"strings"

	"github.com/go-errors/errors"
	"github.com/spf13/afero"
	"github.com/spf13/cobra"
	"github.com/spf13/viper"
	"github.com/supabase/cli/internal/bootstrap"
	"github.com/supabase/cli/internal/utils"
)

var (
	starter = bootstrap.StarterTemplate{
		Name:        "scratch",
		Description: "An empty project from scratch.",
		Start:       "supabase start",
	}

	bootstrapCmd = &cobra.Command{
		GroupID: groupQuickStart,
		Use:     "bootstrap [template]",
		Short:   "Bootstrap a Supabase project from a starter template",
		Args:    cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if !viper.IsSet("WORKDIR") {
				title := fmt.Sprintf("Enter a directory to bootstrap your project (or leave blank to use %s): ", utils.Bold(utils.CurrentDirAbs))
				workdir := utils.NewConsole().PromptText(title)
				viper.Set("WORKDIR", workdir)
			}
			ctx, _ := signal.NotifyContext(cmd.Context(), os.Interrupt)
			client := utils.GetGtihubClient(ctx)
			templates, err := bootstrap.ListSamples(ctx, client)
			if err != nil {
				return err
			}
			if len(args) > 0 {
				name := strings.ToLower(args[0])
				for _, t := range templates {
					if t.Name == name {
						starter = t
						break
					}
				}
				if name != starter.Name {
					return errors.New("Invalid template: " + args[0])
				}
			} else {
				if err := promptStarterTemplate(ctx, templates); err != nil {
					return err
				}
			}
			return bootstrap.Run(ctx, starter, afero.NewOsFs())
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
	items = append(items, utils.PromptItem{
		Index:   len(items),
		Summary: starter.Name,
		Details: starter.Description,
	})
	title := "Which starter template do you want to use?"
	choice, err := utils.PromptChoice(ctx, title, items)
	if err != nil {
		return err
	}
	if choice.Index < len(templates) {
		starter = templates[choice.Index]
	}
	return nil
}
