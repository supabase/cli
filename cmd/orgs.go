package cmd

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"

	"github.com/spf13/cobra"
	"github.com/spf13/viper"
	listMigration "github.com/supabase/cli/internal/migration/list"
	"github.com/supabase/cli/internal/orgs/create"
	"github.com/supabase/cli/internal/orgs/list"
)

var (
	orgsCmd = &cobra.Command{
		GroupID: groupManagementAPI,
		Use:     "orgs",
		Short:   "Manage Supabase organizations",
	}

	orgsListCmd = &cobra.Command{
		Use:   "list",
		Short: "List all organizations",
		Long:  "List all organizations the logged-in user belongs.",
		RunE: func(cmd *cobra.Command, args []string) error {
			orgs, err := list.Run(cmd.Context())
			if err != nil {
				return err
			}
			if orgs != nil {
				table := `|ID|NAME|
|-|-|
`
				for _, org := range *orgs {
					table += fmt.Sprintf("|`%s`|`%s`|\n", org.Id, strings.ReplaceAll(org.Name, "|", "\\|"))
				}

				if viper.GetBool("json") {
					json.NewEncoder(os.Stdout).Encode(*orgs)
				} else {
					listMigration.RenderTable(table)
				}
			}
			return nil
		},
	}

	orgsCreateCmd = &cobra.Command{
		Use:   "create",
		Short: "Create an organization",
		Long:  "Create an organization for the logged-in user.",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			org, err := create.Run(cmd.Context(), args[0])
			if err != nil {
				return err
			}
			if org != nil {
				if viper.GetBool("json") {
					json.NewEncoder(os.Stdout).Encode(org)
				} else {
					fmt.Println("Created organization:", org.Id)
				}
			}
			return nil
		},
	}
)

func init() {
	orgsCmd.AddCommand(orgsListCmd)
	orgsCmd.AddCommand(orgsCreateCmd)
	rootCmd.AddCommand(orgsCmd)
}
