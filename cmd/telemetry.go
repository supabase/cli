package cmd

import (
	"fmt"
	"os"
	"time"

	"github.com/spf13/afero"
	"github.com/spf13/cobra"
	phtelemetry "github.com/supabase/cli/internal/telemetry"
)

var telemetryCmd = &cobra.Command{
	GroupID: groupLocalDev,
	Use:     "telemetry",
	Short:   "Manage CLI telemetry settings",
}

var telemetryEnableCmd = &cobra.Command{
	Use:   "enable",
	Short: "Enable CLI telemetry",
	RunE: func(cmd *cobra.Command, args []string) error {
		if _, err := phtelemetry.SetEnabled(afero.NewOsFs(), true, time.Now()); err != nil {
			return err
		}
		fmt.Fprintln(os.Stdout, "Telemetry is enabled.")
		return nil
	},
}

var telemetryDisableCmd = &cobra.Command{
	Use:   "disable",
	Short: "Disable CLI telemetry",
	RunE: func(cmd *cobra.Command, args []string) error {
		if _, err := phtelemetry.SetEnabled(afero.NewOsFs(), false, time.Now()); err != nil {
			return err
		}
		fmt.Fprintln(os.Stdout, "Telemetry is disabled.")
		return nil
	},
}

var telemetryStatusCmd = &cobra.Command{
	Use:   "status",
	Short: "Show CLI telemetry status",
	RunE: func(cmd *cobra.Command, args []string) error {
		state, _, err := phtelemetry.Status(afero.NewOsFs(), time.Now())
		if err != nil {
			return err
		}
		status := "disabled"
		if state.Enabled {
			status = "enabled"
		}
		fmt.Fprintf(os.Stdout, "Telemetry is %s.\n", status)
		return nil
	},
}

func init() {
	telemetryCmd.AddCommand(telemetryEnableCmd)
	telemetryCmd.AddCommand(telemetryDisableCmd)
	telemetryCmd.AddCommand(telemetryStatusCmd)
	rootCmd.AddCommand(telemetryCmd)
}
