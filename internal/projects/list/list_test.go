package list

import (
	"context"
	"errors"
	"testing"

	"github.com/h2non/gock"
	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/supabase/cli/internal/testing/apitest"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/api"
)

func TestProjectListCommand(t *testing.T) {
	t.Run("lists all projects", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup valid access token
		token := apitest.RandomAccessToken(t)
		t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))
		// Flush pending mocks after test execution
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects").
			Reply(200).
			JSON([]api.V1ProjectResponse{
				{
					Id:             apitest.RandomProjectRef(),
					OrganizationId: "combined-fuchsia-lion",
					Name:           "Test Project",
					Region:         "us-west-1",
					CreatedAt:      "2022-04-25T02:14:55.906498Z",
				},
			})
		// Run test
		_, err := Run(context.Background(), fsys)
		assert.NoError(t, err)
		// Validate api
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on failure to load token", func(t *testing.T) {
		_, err := Run(context.Background(), afero.NewMemMapFs())
		assert.Error(t, err)
	})

	t.Run("throws error on network error", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup valid access token
		token := apitest.RandomAccessToken(t)
		t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))
		// Flush pending mocks after test execution
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects").
			ReplyError(errors.New("network error"))
		// Run test
		_, err := Run(context.Background(), fsys)
		assert.Error(t, err)
		// Validate api
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on server unavailable", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup valid access token
		token := apitest.RandomAccessToken(t)
		t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))
		// Flush pending mocks after test execution
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects").
			Reply(500).
			JSON(map[string]string{"message": "unavailable"})
		// Run test
		_, err := Run(context.Background(), fsys)
		assert.Error(t, err)
		// Validate api
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on malformed json", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup valid access token
		token := apitest.RandomAccessToken(t)
		t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))
		// Flush pending mocks after test execution
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects").
			Reply(200).
			JSON(map[string]string{})
		// Run test
		_, err := Run(context.Background(), fsys)
		assert.Error(t, err)
		// Validate api
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}
