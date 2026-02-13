package cmd

import (
	"github.com/spf13/cobra"
	"github.com/supabase/cli/internal/sandbox"
)

var (
	serverConfigPath string
	serverPort       int

	// sandboxServerCmd is a hidden command used to run the sandbox server
	// as a detached background process. It's spawned by 'supabase start --sandbox'.
	sandboxServerCmd = &cobra.Command{
		Use:    "_sandbox-server",
		Short:  "Run sandbox server (internal use only)",
		Hidden: true,
		RunE: func(cmd *cobra.Command, args []string) error {
			return sandbox.RunServer(serverConfigPath, serverPort)
		},
	}
)

func init() {
	flags := sandboxServerCmd.Flags()
	flags.StringVar(&serverConfigPath, "config", "", "Path to process-compose.yaml")
	flags.IntVar(&serverPort, "port", 0, "HTTP server port")
	cobra.CheckErr(sandboxServerCmd.MarkFlagRequired("config"))
	cobra.CheckErr(sandboxServerCmd.MarkFlagRequired("port"))
	rootCmd.AddCommand(sandboxServerCmd)
}
