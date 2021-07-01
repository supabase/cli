package cmd

import (
	"fmt"

	"github.com/spf13/cobra"
)

// Passed from `-ldflags`: https://stackoverflow.com/q/11354518.
var version string

var versionCmd = &cobra.Command{
	Use:   "version",
	Short: "TODO",
	Long: `TODO`,
	Run: func(cmd *cobra.Command, args []string) {
		fmt.Println(version)
	},
}

func init() {
	rootCmd.AddCommand(versionCmd)
}
