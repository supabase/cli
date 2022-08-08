package cmd

import (
	"fmt"

	"github.com/spf13/afero"
	"github.com/spf13/cobra"
	"github.com/supabase/cli/internal/link"
	"github.com/supabase/cli/internal/utils"
)

var (
	linkCmd = &cobra.Command{
		Use:   "link",
		Short: "Link to a Supabase project",
		RunE: func(cmd *cobra.Command, args []string) error {
			projectRef, err := cmd.Flags().GetString("project-ref")
			if err != nil {
				return err
			}

			fsys := afero.NewOsFs()
			if err := link.Run(projectRef, fsys); err != nil {
				return err
			}

			fmt.Println("Finished " + utils.Aqua("supabase link") + ".")
			return nil
		},
	}
)

func init() {
	linkCmd.Flags().String("project-ref", "", "Project ref of the Supabase project.")
	_ = linkCmd.MarkFlagRequired("project-ref")
	rootCmd.AddCommand(linkCmd)
}
