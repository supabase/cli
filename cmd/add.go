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
		Short:   "Add a template to your project. In non-interactive environments, prints the template schema and installation instructions instead of prompting. Supply inputs via --input flags to install directly.",
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
	flags.BoolVar(&templateRaw, "raw", false, "Print the template schema and exit without applying it. Enabled automatically in non-interactive environments when no --input flags are provided.")
	rootCmd.AddCommand(addCmd)
}
