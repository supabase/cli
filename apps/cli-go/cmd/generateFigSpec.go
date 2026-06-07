package cmd

import (
	generateFigSpec "github.com/withfig/autocomplete-tools/packages/cobra"
)

func init() {
	rootCmd.AddCommand(generateFigSpec.NewCmdGenFigSpec())
}
