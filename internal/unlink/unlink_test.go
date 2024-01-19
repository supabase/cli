package unlink

import (
	"context"
	"testing"

	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/credentials"
)

func TestUnlinkCommand(t *testing.T) {
	project := "test-project"
	password := "test-password"

	t.Run("unlink valid project", func(t *testing.T) {
		// Setup in-memory fs
		// Set up a mock filesystem or a temp directory
		fs := afero.NewMemMapFs() // or setup a real temp directory
		err := afero.WriteFile(fs, "supabase/.temp/project-ref", []byte(project), 0644)
		// Run test
		// Check error
		assert.NoError(t, err)

		// Save database password
		err = credentials.Set(project, password)
		// Check error
		assert.NoError(t, err)
		// Run unlink test
		err = Run(context.Background(), project, fs)
		// Check error
		assert.NoError(t, err)
		// Validate file does not exist
		_, err = afero.ReadFile(fs, utils.ProjectRefPath)
		assert.Error(t, err)
		// check credentials
		// FIXME: only works this way because of the global state
		// of credentials
		content, err := credentials.Get(project)
		assert.Equal(t, "", content)
		assert.NoError(t, err)
	})
}
