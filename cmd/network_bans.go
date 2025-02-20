package cmd

import (
	"github.com/spf13/cobra"
)

var networkBansCmd = &cobra.Command{
	Use:     "network-bans",
	Short:   "Manage network bans",
	GroupID: "management-api",
}

func init() {
	rootCmd.AddCommand(networkBansCmd)
}
