package flags

import (
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
)

func LoadConfig(fsys afero.Fs) error {
	utils.Config.ProjectId = ProjectRef
	if err := utils.Config.Load("", utils.NewRootFS(fsys)); err != nil {
		return err
	}
	utils.UpdateDockerIds()
	return nil
}
