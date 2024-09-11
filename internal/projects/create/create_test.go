package create

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

func TestProjectCreateCommand(t *testing.T) {
	var params = api.V1CreateProjectBody{
		Name:           "Test Project",
		OrganizationId: "combined-fuchsia-lion",
		DbPass:         "redacted",
		Region:         api.V1CreateProjectBodyRegionUsWest1,
	}

	t.Run("creates a new project", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup valid access token
		token := apitest.RandomAccessToken(t)
		t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))
		// Flush pending mocks after test execution
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Post("/v1/projects").
			MatchType("json").
			JSON(params).
			Reply(201).
			JSON(api.V1ProjectResponse{
				Id:             apitest.RandomProjectRef(),
				OrganizationId: params.OrganizationId,
				Name:           params.Name,
				Region:         string(params.Region),
				CreatedAt:      "2022-04-25T02:14:55.906498Z",
			})
		// Run test
		_, err := Run(context.Background(), params, fsys)
		assert.NoError(t, err)
		// Validate api
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on failure to load token", func(t *testing.T) {
		_, err := Run(context.Background(), params, afero.NewMemMapFs())
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
			Post("/v1/projects").
			MatchType("json").
			JSON(params).
			ReplyError(errors.New("network error"))
		// Run test
		_, err := Run(context.Background(), params, fsys)
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
			Post("/v1/projects").
			MatchType("json").
			JSON(params).
			Reply(500).
			JSON(map[string]string{"message": "unavailable"})
		// Run test
		_, err := Run(context.Background(), params, fsys)
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
			Post("/v1/projects").
			MatchType("json").
			JSON(params).
			Reply(200).
			JSON([]string{})
		// Run test
		_, err := Run(context.Background(), params, fsys)
		assert.Error(t, err)
		// Validate api
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}
