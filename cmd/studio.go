package cmd

import (
	"fmt"
	"os/exec"
	"runtime"

	"github.com/spf13/cobra"
	"github.com/supabase/cli/internal/utils"
)

var studioCmd = &cobra.Command{
	Use:   "studio",
	Short: "Opens Supabase Studio in your browser",
	RunE: func(cmd *cobra.Command, args []string) error {
		url := utils.GetSupabaseDashboardURL()
		var err error

		switch runtime.GOOS {
		case "darwin":
			err = exec.Command("open", url).Start()
		case "windows":
			err = exec.Command("cmd", "/c", "start", url).Start()
		default:
			err = exec.Command("xdg-open", url).Start()
		}

		if err != nil {
			return fmt.Errorf("failed to open browser: %w", err)
		}

		fmt.Printf("Opening Supabase Studio at %s\n", utils.Aqua(url))
		return nil
	},
}

func init() {
	rootCmd.AddCommand(studioCmd)
}
