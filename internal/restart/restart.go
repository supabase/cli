package restart

import (
	"context"
	"fmt"
	"io"
	"os"

	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/flags"
)

func Run(ctx context.Context, projectId string, all bool, fsys afero.Fs) error {
	var searchProjectIdFilter string
	if !all {
		// Sanity checks.
		if len(projectId) > 0 {
			utils.Config.ProjectId = projectId
		} else if err := flags.LoadConfig(fsys); err != nil {
			return err
		}
		searchProjectIdFilter = utils.Config.ProjectId
	}

	// Restart all services
	if err := utils.RunProgram(ctx, func(p utils.Program, ctx context.Context) error {
		w := utils.StatusWriter{Program: p}
		return restart(ctx, w, searchProjectIdFilter)
	}); err != nil {
		return err
	}

	fmt.Fprintf(os.Stderr, "Restarted %s local development setup.\n\n", utils.Aqua("supabase"))

	return nil
}

func restart(ctx context.Context, w io.Writer, projectId string) error {
	return utils.DockerRestartAll(ctx, w, projectId)
}
