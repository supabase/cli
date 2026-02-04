package cmd

import (
	"github.com/spf13/cobra"
	"github.com/supabase/cli/internal/sandbox"
)

var (
	proxyPort          int
	proxyGotruePort    int
	proxyPostgrestPort int
	proxyPostgrestAdminPort int
	proxyServiceRoleKey     string
	proxyServiceRoleJWT     string
	proxyAnonKey            string
	proxyAnonJWT            string

	// proxyCmd is a hidden command used to run the API proxy server
	// as a process-compose managed process. It's spawned by process-compose
	// when running in sandbox mode.
	proxyCmd = &cobra.Command{
		Use:    "_proxy",
		Short:  "Run API proxy server (internal use only)",
		Hidden: true,
		RunE: func(cmd *cobra.Command, args []string) error {
			config := &sandbox.ProxyConfig{
				ListenPort:         proxyPort,
				GoTruePort:         proxyGotruePort,
				PostgRESTPort:      proxyPostgrestPort,
				PostgRESTAdminPort: proxyPostgrestAdminPort,
				ServiceRoleKey:     proxyServiceRoleKey,
				ServiceRoleJWT:     proxyServiceRoleJWT,
				AnonKey:            proxyAnonKey,
				AnonJWT:            proxyAnonJWT,
			}
			return sandbox.RunProxy(config)
		},
	}
)

func init() {
	flags := proxyCmd.Flags()
	flags.IntVar(&proxyPort, "port", 0, "Proxy listen port")
	flags.IntVar(&proxyGotruePort, "gotrue-port", 0, "GoTrue backend port")
	flags.IntVar(&proxyPostgrestPort, "postgrest-port", 0, "PostgREST backend port")
	flags.IntVar(&proxyPostgrestAdminPort, "postgrest-admin-port", 0, "PostgREST admin backend port")
	flags.StringVar(&proxyServiceRoleKey, "service-role-key", "", "Service role API key")
	flags.StringVar(&proxyServiceRoleJWT, "service-role-jwt", "", "Service role JWT")
	flags.StringVar(&proxyAnonKey, "anon-key", "", "Anonymous API key")
	flags.StringVar(&proxyAnonJWT, "anon-jwt", "", "Anonymous JWT")

	cobra.CheckErr(proxyCmd.MarkFlagRequired("port"))
	cobra.CheckErr(proxyCmd.MarkFlagRequired("gotrue-port"))
	cobra.CheckErr(proxyCmd.MarkFlagRequired("postgrest-port"))
	cobra.CheckErr(proxyCmd.MarkFlagRequired("postgrest-admin-port"))
	cobra.CheckErr(proxyCmd.MarkFlagRequired("service-role-key"))
	cobra.CheckErr(proxyCmd.MarkFlagRequired("service-role-jwt"))
	cobra.CheckErr(proxyCmd.MarkFlagRequired("anon-key"))
	cobra.CheckErr(proxyCmd.MarkFlagRequired("anon-jwt"))

	rootCmd.AddCommand(proxyCmd)
}
