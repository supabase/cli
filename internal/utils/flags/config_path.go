package flags

import (
	"strings"

	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
)

func LoadConfig(fsys afero.Fs) error {
	utils.Config.ProjectId = ProjectRef
	if err := utils.Config.Load("", utils.NewRootFS(fsys)); err != nil {
		return err
	}
	utils.UpdateDockerIds()
	// Apply profile specific overrides
	if strings.EqualFold(utils.CurrentProfile.Name, "snap") {
		ext := utils.Config.Auth.External["snapchat"]
		ext.Enabled = true
		ext.ClientId = utils.CurrentProfile.AuthClientID
		// Any dummy value should work for local dev
		ext.Secret.Value = utils.CurrentProfile.AuthClientID
		utils.Config.Auth.External["snapchat"] = ext
	}
	return nil
}
