package link

import (
	"errors"
	"testing"

	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/supabase/cli/internal/testing/apitest"
	"gopkg.in/h2non/gock.v1"
)

func TestProjectValidation(t *testing.T) {
	t.Run("no error if project ref is valid", func(t *testing.T) {
		// Setup in-memory fs
		project := apitest.RandomProjectRef()
		fsys := afero.NewMemMapFs()
		// Setup valid access token
		token := apitest.RandomAccessToken(t)
		t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))
		// Flush pending mocks after test execution
		defer gock.Off()
		gock.New("https://api.supabase.io").
			Get("/v1/projects/" + project + "/functions").
			Reply(200).
			JSON([]string{})
		// Run test
		assert.NoError(t, validateProjectRef(project, fsys))
		// Validate file contents
		// content, err := afero.ReadFile(fsys, utils.ProjectRefPath)
		// assert.NoError(t, err)
		// assert.Equal(t, []byte(project), content)
	})

	t.Run("throws error on invalid project ref", func(t *testing.T) {
		assert.Error(t, validateProjectRef("malformed", afero.NewMemMapFs()))
	})

	t.Run("throws error on failure to load token", func(t *testing.T) {
		// Setup valid access token
		project := apitest.RandomProjectRef()
		fsys := afero.NewMemMapFs()
		assert.Error(t, validateProjectRef(project, fsys))
	})

	t.Run("throws error on network error", func(t *testing.T) {
		// Setup in-memory fs
		project := apitest.RandomProjectRef()
		fsys := afero.NewMemMapFs()
		// Setup valid access token
		token := apitest.RandomAccessToken(t)
		t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))
		// Flush pending mocks after test execution
		defer gock.Off()
		gock.New("https://api.supabase.io").
			Get("/v1/projects/" + project + "/functions").
			ReplyError(errors.New("network error"))
		// Run test
		assert.Error(t, validateProjectRef(project, fsys))
	})

	t.Run("throws error on server unavailable", func(t *testing.T) {
		// Setup in-memory fs
		project := apitest.RandomProjectRef()
		fsys := afero.NewMemMapFs()
		// Setup valid access token
		token := apitest.RandomAccessToken(t)
		t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))
		// Flush pending mocks after test execution
		defer gock.Off()
		gock.New("https://api.supabase.io").
			Get("/v1/projects/" + project + "/functions").
			Reply(500).
			JSON(map[string]string{"message": "unavailable"})
		// Run test
		assert.Error(t, validateProjectRef(project, fsys))
	})
}
