package cmd

import (
	"errors"
	"fmt"

	"github.com/spf13/cobra"
	"github.com/supabase/cli/internal/link"
)

var (
	useUrl bool

	linkCmd = &cobra.Command{
		Use:   "link",
		Short: "Link the current project to a remote deploy database.",
		RunE: func(cmd *cobra.Command, args []string) error {
			if useUrl {
				var deployDbUrl string
				fmt.Scanln(&deployDbUrl)
				if len(deployDbUrl) == 0 {
					return errors.New("Error on `supabase link`: URL is empty.")
				}

				return link.Link(deployDbUrl)
			}

			return errors.New("Use `--url` to pass the deploy database URL to link to.")
		},
	}
)

func init() {
	linkCmd.Flags().
		BoolVar(&useUrl, "url", false, "Accept Postgres connection string of the deploy database from standard input.")

	rootCmd.AddCommand(linkCmd)
}
