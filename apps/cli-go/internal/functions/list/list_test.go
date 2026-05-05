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
	"github.com/supabase/cli/internal/testing/fstest"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/api"
	"github.com/supabase/cli/pkg/cast"
)

func TestFunctionsListCommand(t *testing.T) {
	project := apitest.RandomProjectRef()

	t.Run("lists all functions", func(t *testing.T) {
		t.Cleanup(apitest.MockPlatformAPI(t))
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup mock api
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + project + "/functions").
			Reply(http.StatusOK).
			JSON([]api.FunctionResponse{{
				Id:             "test-id",
				Name:           "Test Function",
				Slug:           "test-function",
				Status:         api.FunctionResponseStatusACTIVE,
				UpdatedAt:      1687423025152.000000,
				CreatedAt:      1687423025152.000000,
				Version:        1.000000,
				VerifyJwt:      cast.Ptr(true),
				EntrypointPath: cast.Ptr("test-entrypoint-path"),
				ImportMap:      cast.Ptr(false),
				ImportMapPath:  cast.Ptr("test-import-map-path"),
			}})
		// Run test
		err := Run(context.Background(), project, fsys)
		// Check error
		assert.NoError(t, err)
	})

	t.Run("encodes toml format", func(t *testing.T) {
		utils.OutputFormat.Value = utils.OutputToml
		t.Cleanup(func() { utils.OutputFormat.Value = utils.OutputPretty })
		t.Cleanup(fstest.MockStdout(t, `functions = []
`))
		t.Cleanup(apitest.MockPlatformAPI(t))
		// Setup mock api
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + project + "/functions").
			Reply(http.StatusOK).
			JSON([]api.FunctionResponse{})
		// Run test
		err := Run(context.Background(), project, nil)
		// Check error
		assert.NoError(t, err)
	})

	t.Run("encodes json format", func(t *testing.T) {
		utils.OutputFormat.Value = utils.OutputJson
		t.Cleanup(func() { utils.OutputFormat.Value = utils.OutputPretty })
		t.Cleanup(fstest.MockStdout(t, `[]
`))
		t.Cleanup(apitest.MockPlatformAPI(t))
		// Setup mock api
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + project + "/functions").
			Reply(http.StatusOK).
			JSON([]api.FunctionResponse{})
		// Run test
		err := Run(context.Background(), project, nil)
		// Check error
		assert.NoError(t, err)
	})

	t.Run("throws error on env format", func(t *testing.T) {
		utils.OutputFormat.Value = utils.OutputEnv
		t.Cleanup(func() { utils.OutputFormat.Value = utils.OutputPretty })
		t.Cleanup(apitest.MockPlatformAPI(t))
		// Setup mock api
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + project + "/functions").
			Reply(http.StatusOK).
			JSON([]api.FunctionResponse{})
		// Run test
		err := Run(context.Background(), project, nil)
		// Check error
		assert.ErrorIs(t, err, utils.ErrEnvNotSupported)
	})

	t.Run("throws error on network error", func(t *testing.T) {
		errNetwork := errors.New("network error")
		t.Cleanup(apitest.MockPlatformAPI(t))
		// Setup mock api
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + project + "/functions").
			ReplyError(errNetwork)
		// Run test
		err := Run(context.Background(), project, nil)
		// Check error
		assert.ErrorIs(t, err, errNetwork)
	})

	t.Run("throws error on service unavailable", func(t *testing.T) {
		t.Cleanup(apitest.MockPlatformAPI(t))
		// Setup mock api
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + project + "/functions").
			Reply(http.StatusServiceUnavailable)
		// Run test
		err := Run(context.Background(), project, nil)
		// Check error
		assert.ErrorContains(t, err, "unexpected list functions status 503:")
	})
}
