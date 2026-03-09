package cmd

import (
	"github.com/spf13/afero"
	"github.com/spf13/cobra"
	"github.com/supabase/cli/internal/add"
)

var (
	templateInputs []string
	templateRaw    bool

	addCmd = &cobra.Command{
		GroupID: groupLocalDev,
		Use:     "add <template-slug-or-path>",
		Short:   "Add a template package to your project",
		Hidden:  true,
		Args:    cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return add.Run(cmd.Context(), args[0], templateInputs, templateRaw, afero.NewOsFs())
		},
	}
)

func init() {
	flags := addCmd.Flags()
	flags.StringArrayVarP(&templateInputs, "input", "i", []string{}, "Set template input values as key=value.")
	flags.BoolVar(&templateRaw, "raw", false, "Print the raw template JSON and exit without applying it.")
	rootCmd.AddCommand(addCmd)
}
