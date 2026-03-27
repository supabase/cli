package flags

import (
	"strings"
	"testing"

	"github.com/spf13/afero"
	"github.com/spf13/viper"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/utils"
	configpkg "github.com/supabase/cli/pkg/config"
)

func TestLoadConfigRuntimeSelection(t *testing.T) {
	t.Cleanup(func() {
		viper.Reset()
		ProjectRef = ""
		utils.Config.Runtime.Backend = configpkg.DockerRuntime
		utils.UpdateDockerIds()
	})

	t.Run("uses runtime from config file", func(t *testing.T) {
		fsys := afero.NewMemMapFs()
		require.NoError(t, utils.InitConfig(utils.InitParams{ProjectId: "test-project"}, fsys))

		content, err := afero.ReadFile(fsys, utils.ConfigPath)
		require.NoError(t, err)
		updated := strings.Replace(string(content), `backend = "docker"`, `backend = "apple-container"`, 1)
		require.NoError(t, afero.WriteFile(fsys, utils.ConfigPath, []byte(updated), 0644))

		require.NoError(t, LoadConfig(fsys))
		assert.Equal(t, configpkg.AppleContainerRuntime, utils.Config.Runtime.Backend)
		assert.Equal(t, "supabase-db-test-project", utils.DbId)
	})

	t.Run("flag overrides runtime from config file", func(t *testing.T) {
		fsys := afero.NewMemMapFs()
		require.NoError(t, utils.InitConfig(utils.InitParams{ProjectId: "test-project"}, fsys))

		content, err := afero.ReadFile(fsys, utils.ConfigPath)
		require.NoError(t, err)
		updated := strings.Replace(string(content), `backend = "docker"`, `backend = "apple-container"`, 1)
		require.NoError(t, afero.WriteFile(fsys, utils.ConfigPath, []byte(updated), 0644))

		viper.Set("runtime", "docker")
		require.NoError(t, LoadConfig(fsys))
		assert.Equal(t, configpkg.DockerRuntime, utils.Config.Runtime.Backend)
		assert.Equal(t, "supabase_db_test-project", utils.DbId)
	})
}
