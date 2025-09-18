package list

import (
	"context"
	"errors"
	"net/http"
	"testing"

	"github.com/h2non/gock"
	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/supabase/cli/internal/testing/apitest"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/api"
)

func TestFunctionsListCommand(t *testing.T) {
	// Setup valid project ref
	project := apitest.RandomProjectRef()
	// Setup valid access token
	token := apitest.RandomAccessToken(t)
	t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))

	t.Run("lists all functions", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Flush pending mocks after test execution
		defer gock.OffAll()

		testEntrypointPath := "test-entrypoint-path"
		testImportMapPath := "test-import-map-path"
		testImportMap := false
		testVerifyJwt := true

		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + project + "/functions").
			Reply(200).
			JSON([]api.FunctionResponse{{
				Id:             "test-id",
				Name:           "Test Function",
				Slug:           "test-function",
				Status:         api.FunctionResponseStatusACTIVE,
				UpdatedAt:      1687423025152.000000,
				CreatedAt:      1687423025152.000000,
				Version:        1.000000,
				VerifyJwt:      &testVerifyJwt,
				EntrypointPath: &testEntrypointPath,
				ImportMap:      &testImportMap,
				ImportMapPath:  &testImportMapPath,
			}})
		// Run test
		err := Run(context.Background(), project, fsys)
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on service unavailable", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Flush pending mocks after test execution
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + project + "/functions").
			Reply(http.StatusServiceUnavailable)
		// Run test
		err := Run(context.Background(), project, fsys)
		// Check error
		assert.ErrorContains(t, err, "unexpected list functions status 503:")
	})

	t.Run("throws error on network error", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Flush pending mocks after test execution
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + project + "/functions").
			ReplyError(errors.New("network error"))
		// Run test
		err := Run(context.Background(), project, fsys)
		// Check error
		assert.ErrorContains(t, err, "network error")
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}
