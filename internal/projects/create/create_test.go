package create

import (
	"errors"
	"testing"

	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/supabase/cli/internal/projects/list"
	"github.com/supabase/cli/internal/testing/apitest"
	"gopkg.in/h2non/gock.v1"
)

func TestProjectCreateCommand(t *testing.T) {
	var params = RequestParam{
		Name:   "Test Project",
		OrgId:  "combined-fuchsia-lion",
		DbPass: "redacted",
		Region: "us-west-1",
		Plan:   "free",
	}

	t.Run("creates a new project", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup valid access token
		token := apitest.RandomAccessToken(t)
		t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))
		// Flush pending mocks after test execution
		defer gock.Off()
		gock.New("https://api.supabase.io").
			Post("/v1/projects").
			Reply(201).
			JSON(list.Project{
				Id:        "bcnzkuicchyuaswrezwk",
				OrgId:     params.OrgId,
				Name:      params.Name,
				Region:    params.Region,
				CreatedAt: "2022-04-25T02:14:55.906498Z",
			})
		// Run test
		assert.NoError(t, Run(params, fsys))
	})

	t.Run("throws error on failure to load token", func(t *testing.T) {
		assert.Error(t, Run(params, afero.NewMemMapFs()))
	})

	t.Run("throws error on network error", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup valid access token
		token := apitest.RandomAccessToken(t)
		t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))
		// Flush pending mocks after test execution
		defer gock.Off()
		gock.New("https://api.supabase.io").
			Post("/v1/projects").
			ReplyError(errors.New("network error"))
		// Run test
		assert.Error(t, Run(params, fsys))
	})

	t.Run("throws error on server unavailable", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup valid access token
		token := apitest.RandomAccessToken(t)
		t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))
		// Flush pending mocks after test execution
		defer gock.Off()
		gock.New("https://api.supabase.io").
			Post("/v1/projects").
			Reply(500).
			JSON(map[string]string{"message": "unavailable"})
		// Run test
		assert.Error(t, Run(params, fsys))
	})

	t.Run("throws error on malformed json", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup valid access token
		token := apitest.RandomAccessToken(t)
		t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))
		// Flush pending mocks after test execution
		defer gock.Off()
		gock.New("https://api.supabase.io").
			Post("/v1/projects").
			Reply(200).
			JSON([]string{})
		// Run test
		assert.Error(t, Run(params, fsys))
	})
}
