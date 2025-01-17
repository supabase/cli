package cmd

import (
	"fmt"
	"os/exec"
	"runtime"
	"os"

	"github.com/spf13/cobra"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/flags"
	"github.com/supabase/cli/internal/login"
)

var studioCmd = &cobra.Command{
	Use:   "studio",
	Short: "Opens Supabase Studio in your browser",
	RunE: func(cmd *cobra.Command, args []string) error {

		fsys := afero.NewOsFs()
		if err := flags.LoadConfig(fsys); err != nil {
			return err
		}
		
		var url string
		if utils.Config.Studio.Enabled {
			url = fmt.Sprintf("http://%s:%d", utils.Config.Hostname, utils.Config.Studio.Port)
		} else {
			fmt.Fprintln(os.Stderr, "Can't open studio because it is disabled in config.toml for project:", flags.ProjectRef)
			return nil
		}

		var err error
		ctx := cmd.Context()

		switch runtime.GOOS {
		case "darwin":
			err = exec.Command("open", url).Start()
		case "windows", "linux":
			err = login.RunOpenCmd(ctx, url)
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
