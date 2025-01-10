package push

import (
	"context"
	"fmt"
	"os"

	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/flags"
	"github.com/supabase/cli/pkg/config"
)

func Run(ctx context.Context, ref string, fsys afero.Fs) error {
	if err := flags.LoadConfig(fsys); err != nil {
		return err
	}
	client := config.NewConfigUpdater(*utils.GetSupabase())
	remote, err := utils.Config.GetRemoteByProjectRef(ref)
	if err != nil {
		// Use base config when no remote is declared
		remote.ProjectId = ref
	}
	fmt.Fprintln(os.Stderr, "Pushing config to project:", remote.ProjectId)
	console := utils.NewConsole()
	keep := func(name string) bool {
		title := fmt.Sprintf("Do you want to push %s config to remote?", name)
		shouldPush, err := console.PromptYesNo(ctx, title, true)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
		}
		return shouldPush
	}
	return client.UpdateRemoteConfig(ctx, remote, keep)
}
