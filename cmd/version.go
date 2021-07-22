package cmd

import (
	"fmt"

	"github.com/spf13/cobra"
)

// Passed from `-ldflags`: https://stackoverflow.com/q/11354518.
var version string

var versionCmd = &cobra.Command{
	Use:   "version",
	Short: "FIXME",
	Long: `FIXME`,
	Run: func(cmd *cobra.Command, args []string) {
		fmt.Print(version)
	},
}

func init() {
	rootCmd.AddCommand(versionCmd)
}
