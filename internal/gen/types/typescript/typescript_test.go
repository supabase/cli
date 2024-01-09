package typescript

import (
	"context"
	"errors"
	"net/http"
	"testing"

	"github.com/docker/docker/api/types"
	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/testing/apitest"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/api"
	"gopkg.in/h2non/gock.v1"
)

func TestGenLocalCommand(t *testing.T) {
	t.Run("generates typescript types", func(t *testing.T) {
		containerId := "test-pgmeta"
		imageUrl := utils.GetRegistryImageUrl(utils.PgmetaImage)
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, utils.WriteConfig(fsys, false))
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/containers").
			Reply(200).
			JSON(types.ContainerJSON{})
		apitest.MockDockerStart(utils.Docker, imageUrl, containerId)
		require.NoError(t, apitest.MockDockerLogs(utils.Docker, containerId, "hello world"))
		// Run test
		assert.NoError(t, Run(context.Background(), true, false, "", "", []string{}, true, fsys))
		// Validate api
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on missing config", func(t *testing.T) {
		assert.Error(t, Run(context.Background(), true, false, "", "", []string{}, true, afero.NewMemMapFs()))
	})

	t.Run("throws error when db is not started", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, utils.WriteConfig(fsys, false))
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/containers").
			Reply(http.StatusServiceUnavailable)
		// Run test
		assert.Error(t, Run(context.Background(), true, false, "", "", []string{}, true, fsys))
		// Validate api
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on image fetch failure", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, utils.WriteConfig(fsys, false))
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/containers").
			Reply(200).
			JSON(types.ContainerJSON{})
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/images").
			Reply(http.StatusServiceUnavailable)
		// Run test
		assert.Error(t, Run(context.Background(), true, false, "", "", []string{}, true, fsys))
		// Validate api
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}

func TestGenLinkedCommand(t *testing.T) {
	t.Run("generates typescript types", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, utils.WriteConfig(fsys, false))
		// Setup valid projectId id
		projectId := apitest.RandomProjectRef()
		require.NoError(t, afero.WriteFile(fsys, utils.ProjectRefPath, []byte(projectId), 0644))
		// Setup valid access token
		token := apitest.RandomAccessToken(t)
		t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))
		// Flush pending mocks after test execution
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + projectId + "/types/typescript").
			Reply(200).
			JSON(api.TypescriptResponse{Types: ""})
		// Run test
		assert.NoError(t, Run(context.Background(), false, true, "", "", []string{}, true, fsys))
		// Validate api
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on missing config file", func(t *testing.T) {
		assert.Error(t, Run(context.Background(), false, true, "", "", []string{}, true, afero.NewMemMapFs()))
	})

	t.Run("throws error on missing project id", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, utils.WriteConfig(fsys, false))
		// Run test
		assert.Error(t, Run(context.Background(), false, true, "", "", []string{}, true, fsys))
	})

	t.Run("throws error on missing access token", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, utils.WriteConfig(fsys, false))
		// Setup valid projectId id
		projectId := apitest.RandomProjectRef()
		require.NoError(t, afero.WriteFile(fsys, utils.ProjectRefPath, []byte(projectId), 0644))
		// Run test
		assert.Error(t, Run(context.Background(), false, true, "", "", []string{}, true, fsys))
	})

	t.Run("throws error on network failure", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, utils.WriteConfig(fsys, false))
		// Setup valid projectId id
		projectId := apitest.RandomProjectRef()
		require.NoError(t, afero.WriteFile(fsys, utils.ProjectRefPath, []byte(projectId), 0644))
		// Setup valid access token
		token := apitest.RandomAccessToken(t)
		t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))
		// Flush pending mocks after test execution
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + projectId + "/types/typescript").
			ReplyError(errors.New("network failure"))
		// Run test
		err := Run(context.Background(), false, true, "", "", []string{}, true, fsys)
		// Validate api
		assert.ErrorContains(t, err, "network failure")
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}

func TestGenProjectIdCommand(t *testing.T) {
	t.Run("generates typescript types", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup valid projectId id
		projectId := apitest.RandomProjectRef()
		// Setup valid access token
		token := apitest.RandomAccessToken(t)
		t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))
		// Flush pending mocks after test execution
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + projectId + "/types/typescript").
			Reply(200).
			JSON(api.TypescriptResponse{Types: ""})
		// Run test
		assert.NoError(t, Run(context.Background(), false, false, projectId, "", []string{}, true, fsys))
		// Validate api
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on missing access token", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup valid projectId id
		projectId := apitest.RandomProjectRef()
		// Run test
		assert.Error(t, Run(context.Background(), false, false, projectId, "", []string{}, true, fsys))
	})

	t.Run("throws error on network failure", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup valid projectId id
		projectId := apitest.RandomProjectRef()
		// Setup valid access token
		token := apitest.RandomAccessToken(t)
		t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))
		// Flush pending mocks after test execution
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + projectId + "/types/typescript").
			ReplyError(errors.New("network failure"))
		// Run test
		err := Run(context.Background(), false, false, projectId, "", []string{}, true, fsys)
		// Validate api
		assert.ErrorContains(t, err, "network failure")
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}

func TestGenRemoteCommand(t *testing.T) {
	const dbUrl = "postgres://postgres:@127.0.0.1:5432/postgres"
	const containerId = "test-container"

	t.Run("generates type from remote db", func(t *testing.T) {
		imageUrl := utils.GetRegistryImageUrl(utils.PgmetaImage)
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		apitest.MockDockerStart(utils.Docker, imageUrl, containerId)
		require.NoError(t, apitest.MockDockerLogs(utils.Docker, containerId, "hello world"))
		// Run test
		assert.NoError(t, Run(context.Background(), false, false, "", dbUrl, []string{}, true, afero.NewMemMapFs()))
		// Validate api
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on malformed db url", func(t *testing.T) {
		// Run test
		assert.Error(t, Run(context.Background(), false, false, "", "foo", []string{}, true, afero.NewMemMapFs()))
	})

	t.Run("throws error when docker is not started", func(t *testing.T) {
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/images").
			Reply(http.StatusServiceUnavailable)
		// Run test
		assert.Error(t, Run(context.Background(), false, false, "", dbUrl, []string{}, true, afero.NewMemMapFs()))
		// Validate api
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}
