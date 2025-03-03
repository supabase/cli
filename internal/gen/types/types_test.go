package types

import (
	"context"
	"errors"
	"net/http"
	"testing"

	"github.com/docker/docker/api/types/container"
	"github.com/h2non/gock"
	"github.com/jackc/pgconn"
	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/testing/apitest"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/api"
	"github.com/supabase/cli/pkg/pgtest"
)

func TestGenLocalCommand(t *testing.T) {
	utils.DbId = "test-db"
	utils.Config.Hostname = "localhost"
	utils.Config.Db.Port = 5432

	dbConfig := pgconn.Config{
		Host:     utils.Config.Hostname,
		Port:     utils.Config.Db.Port,
		User:     "admin",
		Password: "password",
	}

	t.Run("generates typescript types", func(t *testing.T) {
		const containerId = "test-pgmeta"
		imageUrl := utils.GetRegistryImageUrl(utils.Config.Studio.PgmetaImage)
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/containers/" + utils.DbId).
			Reply(http.StatusOK).
			JSON(container.InspectResponse{})
		apitest.MockDockerStart(utils.Docker, imageUrl, containerId)
		require.NoError(t, apitest.MockDockerLogs(utils.Docker, containerId, "hello world\n"))
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		// Run test
		assert.NoError(t, Run(context.Background(), "", dbConfig, LangTypescript, []string{}, true, "", fsys, conn.Intercept))
		// Validate api
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error when db is not started", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/containers/" + utils.DbId).
			Reply(http.StatusServiceUnavailable)
		// Run test
		assert.Error(t, Run(context.Background(), "", dbConfig, LangTypescript, []string{}, true, "", fsys))
		// Validate api
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on image fetch failure", func(t *testing.T) {
		utils.Config.Api.Image = "v9"
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/containers/" + utils.DbId).
			Reply(http.StatusOK).
			JSON(container.InspectResponse{})
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/images").
			Reply(http.StatusServiceUnavailable)
		// Run test
		assert.Error(t, Run(context.Background(), "", dbConfig, LangTypescript, []string{}, true, "", fsys))
		// Validate api
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("generates swift types", func(t *testing.T) {
		const containerId = "test-pgmeta"
		imageUrl := utils.GetRegistryImageUrl(utils.Config.Studio.PgmetaImage)
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/containers/" + utils.DbId).
			Reply(http.StatusOK).
			JSON(container.InspectResponse{})
		apitest.MockDockerStart(utils.Docker, imageUrl, containerId)
		require.NoError(t, apitest.MockDockerLogs(utils.Docker, containerId, "hello world\n"))
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		// Run test
		assert.NoError(t, Run(context.Background(), "", dbConfig, LangSwift, []string{}, true, SwiftInternalAccessControl, fsys, conn.Intercept))
		// Validate api
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}

func TestGenLinkedCommand(t *testing.T) {
	// Setup valid projectId id
	projectId := apitest.RandomProjectRef()
	// Setup valid access token
	token := apitest.RandomAccessToken(t)
	t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))

	t.Run("generates typescript types", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Flush pending mocks after test execution
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + projectId + "/types/typescript").
			Reply(200).
			JSON(api.TypescriptResponse{Types: ""})
		// Run test
		assert.NoError(t, Run(context.Background(), projectId, pgconn.Config{}, LangTypescript, []string{}, true, "", fsys))
		// Validate api
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on network failure", func(t *testing.T) {
		errNetwork := errors.New("network error")
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Flush pending mocks after test execution
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + projectId + "/types/typescript").
			ReplyError(errNetwork)
		// Run test
		err := Run(context.Background(), projectId, pgconn.Config{}, LangTypescript, []string{}, true, "", fsys)
		// Validate api
		assert.ErrorIs(t, err, errNetwork)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on service unavailable", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Flush pending mocks after test execution
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + projectId + "/types/typescript").
			Reply(http.StatusServiceUnavailable)
		// Run test
		assert.Error(t, Run(context.Background(), projectId, pgconn.Config{}, LangTypescript, []string{}, true, "", fsys))
	})
}

func TestGenRemoteCommand(t *testing.T) {
	dbConfig := pgconn.Config{
		Host:     "db.supabase.co",
		Port:     5432,
		User:     "admin",
		Password: "password",
		Database: "postgres",
	}

	t.Run("generates type from remote db", func(t *testing.T) {
		const containerId = "test-pgmeta"
		imageUrl := utils.GetRegistryImageUrl(utils.Config.Studio.PgmetaImage)
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		apitest.MockDockerStart(utils.Docker, imageUrl, containerId)
		require.NoError(t, apitest.MockDockerLogs(utils.Docker, containerId, "hello world\n"))
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		// Run test
		assert.NoError(t, Run(context.Background(), "", dbConfig, LangTypescript, []string{"public"}, true, "", afero.NewMemMapFs(), conn.Intercept))
		// Validate api
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}
