package flags

import (
	"fmt"
	"os"

	"github.com/go-errors/errors"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
)

func LoadConfig(fsys afero.Fs) error {
	utils.Config.ProjectId = ProjectRef
	if err := utils.Config.Load("", utils.NewRootFS(fsys)); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			utils.CmdSuggestion = fmt.Sprintf("Have you set up the project with %s?", utils.Aqua("supabase init"))
		}
		return err
	}
	utils.UpdateDockerIds()
	return nil
}
