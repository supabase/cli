package flags

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/go-errors/errors"
	"github.com/spf13/afero"
	"github.com/spf13/viper"
	"github.com/supabase/cli/internal/utils"
)

var ConfigFile string

func LoadConfig(fsys afero.Fs) error {
	// Early return if no config file specified
	if ConfigFile == "" {
		utils.Config.ProjectId = ProjectRef
		return nil
	}

	utils.Config.ProjectId = ProjectRef

	// Step 1: Normalize the config path
	configPath := filepath.ToSlash(ConfigFile)
	
	// Step 2: Handle absolute paths and set workdir
	var workdir string
	if filepath.IsAbs(ConfigFile) {
		// Remove drive letter if present (Windows)
		if i := strings.Index(configPath, ":"); i > 0 {
			configPath = configPath[i+1:]
		}
		// Ensure path starts with /
		if !strings.HasPrefix(configPath, "/") {
			configPath = "/" + configPath
		}
		workdir = filepath.Dir(configPath)
	} else {
		workdir = filepath.Dir(configPath)
	}

	// Step 3: Normalize workdir
	workdir = filepath.ToSlash(workdir)
	if filepath.IsAbs(ConfigFile) && !strings.HasPrefix(workdir, "/") {
		workdir = "/" + workdir
	}

	// Step 4: Set workdir in viper
	viper.Set("WORKDIR", workdir)

	// Step 5: Load and validate config
	if err := utils.Config.Load(configPath, utils.NewRootFS(fsys)); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			utils.CmdSuggestion = fmt.Sprintf("Have you set up the project with %s?", utils.Aqua("supabase init"))
		}
		return err
	}

	utils.UpdateDockerIds()
	return nil
}
