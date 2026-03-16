package start

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"regexp"
	"strings"
	"testing"

	"github.com/docker/docker/api/types"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/image"
	"github.com/docker/docker/api/types/network"
	"github.com/docker/docker/api/types/volume"
	"github.com/h2non/gock"
	"github.com/jackc/pgconn"
	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/testing/apitest"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/config"
	"github.com/supabase/cli/pkg/pgtest"
	"github.com/supabase/cli/pkg/storage"
)

func TestStartCommand(t *testing.T) {
	t.Run("throws error on malformed config", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, afero.WriteFile(fsys, utils.ConfigPath, []byte("malformed"), 0644))
		// Run test
		err := Run(context.Background(), fsys, []string{}, false)
		// Check error
		assert.ErrorContains(t, err, "toml: expected = after a key, but the document ends there")
	})

	t.Run("throws error on missing docker", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, utils.WriteConfig(fsys, false))
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/containers").
			ReplyError(errors.New("network error"))
		// Run test
		err := Run(context.Background(), fsys, []string{}, false)
		// Check error
		assert.ErrorContains(t, err, "network error")
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("show status if database is already running", func(t *testing.T) {
		var running []container.Summary
		for _, name := range utils.GetDockerIds() {
			running = append(running, container.Summary{
				Names: []string{name + "_test"},
			})
		}
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, utils.WriteConfig(fsys, false))
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/containers").
			Reply(http.StatusOK).
			JSON(container.InspectResponse{})

		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/containers/supabase_db_start/json").
			Reply(http.StatusOK).
			JSON(container.InspectResponse{ContainerJSONBase: &container.ContainerJSONBase{
				State: &container.State{
					Running: true,
				},
			}})
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/containers/json").
			Persist().
			Reply(http.StatusOK).
			JSON(running)
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/networks").
			Reply(http.StatusOK).
			JSON([]network.Summary{})
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/volumes").
			Reply(http.StatusOK).
			JSON(volume.ListResponse{})
		// Run test
		err := Run(context.Background(), fsys, []string{}, false)
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}

func TestDatabaseStart(t *testing.T) {
	t.Run("starts database locally", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		gock.New(utils.Docker.DaemonHost()).
			Head("/_ping").
			Reply(http.StatusOK)
		gock.New(utils.Docker.DaemonHost()).
			Post("/v" + utils.Docker.ClientVersion() + "/networks/create").
			Reply(http.StatusCreated).
			JSON(network.CreateResponse{})
		// Caches all dependencies
		imageUrl := utils.GetRegistryImageUrl(utils.Config.Db.Image)
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/images/" + imageUrl + "/json").
			Reply(http.StatusOK).
			JSON(image.InspectResponse{})
		for _, img := range config.Images.Services() {
			service := utils.GetRegistryImageUrl(img)
			gock.New(utils.Docker.DaemonHost()).
				Get("/v" + utils.Docker.ClientVersion() + "/images/" + service + "/json").
				Reply(http.StatusOK).
				JSON(image.InspectResponse{})
		}
		// Start postgres
		utils.DbId = "test-postgres"
		utils.Config.Db.Port = 54322
		utils.Config.Db.MajorVersion = 15
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/volumes/" + utils.DbId).
			Reply(http.StatusNotFound)
		apitest.MockDockerStart(utils.Docker, imageUrl, utils.DbId)
		apitest.MockDockerStart(utils.Docker, utils.GetRegistryImageUrl(utils.Config.Realtime.Image), "test-realtime")
		require.NoError(t, apitest.MockDockerLogs(utils.Docker, "test-realtime", ""))
		apitest.MockDockerStart(utils.Docker, utils.GetRegistryImageUrl(utils.Config.Storage.Image), "test-storage")
		require.NoError(t, apitest.MockDockerLogs(utils.Docker, "test-storage", ""))
		apitest.MockDockerStart(utils.Docker, utils.GetRegistryImageUrl(utils.Config.Auth.Image), "test-auth")
		require.NoError(t, apitest.MockDockerLogs(utils.Docker, "test-auth", ""))
		// Start services
		utils.KongId = "test-kong"
		apitest.MockDockerStart(utils.Docker, utils.GetRegistryImageUrl(utils.Config.Api.KongImage), utils.KongId)
		utils.GotrueId = "test-gotrue"
		utils.Config.Auth.EnableSignup = true
		utils.Config.Auth.Email.EnableSignup = true
		utils.Config.Auth.Email.DoubleConfirmChanges = true
		utils.Config.Auth.Email.EnableConfirmations = true
		apitest.MockDockerStart(utils.Docker, utils.GetRegistryImageUrl(utils.Config.Auth.Image), utils.GotrueId)
		utils.InbucketId = "test-inbucket"
		apitest.MockDockerStart(utils.Docker, utils.GetRegistryImageUrl(utils.Config.Inbucket.Image), utils.InbucketId)
		utils.RealtimeId = "test-realtime"
		apitest.MockDockerStart(utils.Docker, utils.GetRegistryImageUrl(utils.Config.Realtime.Image), utils.RealtimeId)
		utils.RestId = "test-rest"
		apitest.MockDockerStart(utils.Docker, utils.GetRegistryImageUrl(utils.Config.Api.Image), utils.RestId)
		utils.StorageId = "test-storage"
		apitest.MockDockerStart(utils.Docker, utils.GetRegistryImageUrl(utils.Config.Storage.Image), utils.StorageId)
		utils.ImgProxyId = "test-imgproxy"
		apitest.MockDockerStart(utils.Docker, utils.GetRegistryImageUrl(utils.Config.Storage.ImgProxyImage), utils.ImgProxyId)
		utils.EdgeRuntimeId = "test-edge-runtime"
		apitest.MockDockerStart(utils.Docker, utils.GetRegistryImageUrl(utils.Config.EdgeRuntime.Image), utils.EdgeRuntimeId)
		utils.PgmetaId = "test-pgmeta"
		apitest.MockDockerStart(utils.Docker, utils.GetRegistryImageUrl(utils.Config.Studio.PgmetaImage), utils.PgmetaId)
		utils.StudioId = "test-studio"
		apitest.MockDockerStart(utils.Docker, utils.GetRegistryImageUrl(utils.Config.Studio.Image), utils.StudioId)
		utils.LogflareId = "test-logflare"
		apitest.MockDockerStart(utils.Docker, utils.GetRegistryImageUrl(utils.Config.Analytics.Image), utils.LogflareId)
		utils.VectorId = "test-vector"
		apitest.MockDockerStart(utils.Docker, utils.GetRegistryImageUrl(utils.Config.Analytics.VectorImage), utils.VectorId)
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		// Setup health probes
		started := []string{
			utils.DbId, utils.KongId, utils.GotrueId, utils.InbucketId, utils.RealtimeId,
			utils.StorageId, utils.ImgProxyId, utils.EdgeRuntimeId, utils.PgmetaId, utils.StudioId,
			utils.LogflareId, utils.RestId, utils.VectorId,
		}
		for _, c := range started {
			gock.New(utils.Docker.DaemonHost()).
				Get("/v" + utils.Docker.ClientVersion() + "/containers/" + c + "/json").
				Reply(http.StatusOK).
				JSON(container.InspectResponse{ContainerJSONBase: &container.ContainerJSONBase{
					State: &container.State{
						Running: true,
						Health:  &container.Health{Status: types.Healthy},
					},
				}})
		}
		gock.New(utils.Config.Api.ExternalUrl).
			Head("/rest-admin/v1/ready").
			Reply(http.StatusOK)
		gock.New(utils.Config.Api.ExternalUrl).
			Head("/functions/v1/_internal/health").
			Reply(http.StatusOK)
		// Seed tenant services
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/containers/" + utils.StorageId + "/json").
			Reply(http.StatusOK).
			JSON(container.InspectResponse{ContainerJSONBase: &container.ContainerJSONBase{
				State: &container.State{
					Running: true,
					Health:  &container.Health{Status: types.Healthy},
				},
			}})
		gock.New(utils.Config.Api.ExternalUrl).
			Get("/storage/v1/bucket").
			Reply(http.StatusOK).
			JSON([]storage.BucketResponse{})
		// Run test
		err := run(context.Background(), fsys, []string{}, pgconn.Config{Host: utils.DbId}, conn.Intercept)
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("skips excluded containers", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		defer gock.OffAll()
		gock.New(utils.Docker.DaemonHost()).
			Head("/_ping").
			Reply(http.StatusOK)
		gock.New(utils.Docker.DaemonHost()).
			Post("/v" + utils.Docker.ClientVersion() + "/networks/create").
			Reply(http.StatusCreated).
			JSON(network.CreateResponse{})
		// Caches all dependencies
		imageUrl := utils.GetRegistryImageUrl(utils.Config.Db.Image)
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/images/" + imageUrl + "/json").
			Reply(http.StatusOK).
			JSON(image.InspectResponse{})
		// Start postgres
		utils.DbId = "test-postgres"
		utils.Config.Db.Port = 54322
		utils.Config.Db.MajorVersion = 15
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/volumes/" + utils.DbId).
			Reply(http.StatusOK).
			JSON(volume.Volume{})
		apitest.MockDockerStart(utils.Docker, imageUrl, utils.DbId)
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/containers/" + utils.DbId + "/json").
			Reply(http.StatusOK).
			JSON(container.InspectResponse{ContainerJSONBase: &container.ContainerJSONBase{
				State: &container.State{
					Running: true,
					Health:  &container.Health{Status: types.Healthy},
				},
			}})
		// Run test
		exclude := ExcludableContainers()
		exclude = append(exclude, "invalid", exclude[0])
		err := run(context.Background(), fsys, exclude, pgconn.Config{Host: utils.DbId})
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}

func TestRuntimeContainerHost(t *testing.T) {
	t.Run("uses container ip on apple for started services", func(t *testing.T) {
		originalRuntime := utils.Config.Local.Runtime
		originalResolver := resolveContainerIP
		t.Cleanup(func() {
			utils.Config.Local.Runtime = originalRuntime
			resolveContainerIP = originalResolver
		})
		utils.Config.Local.Runtime = config.AppleContainerRuntime
		resolveContainerIP = func(_ context.Context, containerId, networkName string) (string, error) {
			assert.Equal(t, utils.NetId, networkName)
			return "192.168.0.10", nil
		}

		host, err := runtimeContainerHost(context.Background(), "test-service", true)
		require.NoError(t, err)
		assert.Equal(t, "192.168.0.10", host)
	})

	t.Run("keeps container name when runtime does not need resolution", func(t *testing.T) {
		originalRuntime := utils.Config.Local.Runtime
		originalResolver := resolveContainerIP
		t.Cleanup(func() {
			utils.Config.Local.Runtime = originalRuntime
			resolveContainerIP = originalResolver
		})
		utils.Config.Local.Runtime = config.DockerRuntime
		resolveContainerIP = func(_ context.Context, _, _ string) (string, error) {
			t.Fatal("resolver should not be called")
			return "", nil
		}

		host, err := runtimeContainerHost(context.Background(), "test-service", true)
		require.NoError(t, err)
		assert.Equal(t, "test-service", host)
	})
}

func TestBuildKongConfig(t *testing.T) {
	originalRuntime := utils.Config.Local.Runtime
	originalResolver := resolveContainerIP
	originalIDs := struct {
		gotrue, rest, realtime, storage, studio, pgmeta, edge, logflare, pooler string
	}{
		gotrue:   utils.GotrueId,
		rest:     utils.RestId,
		realtime: utils.RealtimeId,
		storage:  utils.StorageId,
		studio:   utils.StudioId,
		pgmeta:   utils.PgmetaId,
		edge:     utils.EdgeRuntimeId,
		logflare: utils.LogflareId,
		pooler:   utils.PoolerId,
	}
	t.Cleanup(func() {
		utils.Config.Local.Runtime = originalRuntime
		resolveContainerIP = originalResolver
		utils.GotrueId = originalIDs.gotrue
		utils.RestId = originalIDs.rest
		utils.RealtimeId = originalIDs.realtime
		utils.StorageId = originalIDs.storage
		utils.StudioId = originalIDs.studio
		utils.PgmetaId = originalIDs.pgmeta
		utils.EdgeRuntimeId = originalIDs.edge
		utils.LogflareId = originalIDs.logflare
		utils.PoolerId = originalIDs.pooler
	})
	utils.Config.Local.Runtime = config.AppleContainerRuntime
	utils.GotrueId = "test-gotrue"
	utils.RestId = "test-rest"
	utils.RealtimeId = "test-realtime"
	utils.StorageId = "test-storage"
	utils.StudioId = "test-studio"
	utils.PgmetaId = "test-pgmeta"
	utils.EdgeRuntimeId = "test-edge"
	utils.LogflareId = "test-logflare"
	utils.PoolerId = "test-pooler"
	resolveContainerIP = func(_ context.Context, containerId, _ string) (string, error) {
		return map[string]string{
			"test-gotrue":   "192.168.0.11",
			"test-rest":     "192.168.0.12",
			"test-realtime": "192.168.0.13",
			"test-storage":  "192.168.0.14",
			"test-pgmeta":   "192.168.0.15",
			"test-edge":     "192.168.0.16",
			"test-logflare": "192.168.0.17",
			"test-pooler":   "192.168.0.18",
		}[containerId], nil
	}

	cfg, err := buildKongConfig(context.Background(), KongDependencies{
		Gotrue:   true,
		Rest:     true,
		Realtime: true,
		Storage:  true,
		Studio:   false,
		Pgmeta:   true,
		Edge:     true,
		Logflare: true,
		Pooler:   true,
	})
	require.NoError(t, err)
	assert.Equal(t, "192.168.0.11", cfg.GotrueId)
	assert.Equal(t, "192.168.0.12", cfg.RestId)
	assert.Equal(t, "192.168.0.13", cfg.RealtimeId)
	assert.Equal(t, "192.168.0.14", cfg.StorageId)
	assert.Equal(t, "test-studio", cfg.StudioId)
	assert.Equal(t, "192.168.0.15", cfg.PgmetaId)
	assert.Equal(t, "192.168.0.16", cfg.EdgeRuntimeId)
	assert.Equal(t, "192.168.0.17", cfg.LogflareId)
	assert.Equal(t, "192.168.0.18", cfg.PoolerId)
}

func TestRuntimeContainerURL(t *testing.T) {
	originalRuntime := utils.Config.Local.Runtime
	originalResolver := resolveContainerIP
	t.Cleanup(func() {
		utils.Config.Local.Runtime = originalRuntime
		resolveContainerIP = originalResolver
	})
	utils.Config.Local.Runtime = config.AppleContainerRuntime
	resolveContainerIP = func(_ context.Context, _, _ string) (string, error) {
		return "192.168.0.20", nil
	}

	url, err := runtimeContainerURL(context.Background(), "test-kong", 8000, true)
	require.NoError(t, err)
	assert.Equal(t, "http://192.168.0.20:8000", url)
}

func TestReconcileStaleProjectContainers(t *testing.T) {
	originalLister := listProjectContainers
	originalRemover := removeProjectContainer
	t.Cleanup(func() {
		listProjectContainers = originalLister
		removeProjectContainer = originalRemover
	})

	t.Run("removes only stopped project containers", func(t *testing.T) {
		var removed []string
		listProjectContainers = func(_ context.Context, projectId string, all bool) ([]utils.ContainerInfo, error) {
			assert.Equal(t, "demo", projectId)
			assert.True(t, all)
			return []utils.ContainerInfo{
				{ID: "supabase-db-demo", Running: true},
				{ID: "supabase-rest-demo", Running: false},
			}, nil
		}
		removeProjectContainer = func(_ context.Context, containerId string, removeVolumes, force bool) error {
			assert.True(t, removeVolumes)
			assert.True(t, force)
			removed = append(removed, containerId)
			return nil
		}

		err := reconcileStaleProjectContainers(context.Background(), "demo")

		require.NoError(t, err)
		assert.Equal(t, []string{"supabase-rest-demo"}, removed)
	})

	t.Run("returns removal errors", func(t *testing.T) {
		listProjectContainers = func(_ context.Context, _ string, _ bool) ([]utils.ContainerInfo, error) {
			return []utils.ContainerInfo{{ID: "supabase-rest-demo", Running: false}}, nil
		}
		removeProjectContainer = func(_ context.Context, _ string, _, _ bool) error {
			return errors.New("boom")
		}

		err := reconcileStaleProjectContainers(context.Background(), "demo")

		require.Error(t, err)
		assert.ErrorContains(t, err, "failed to remove stale container")
	})
}

func TestBuildStudioEnv(t *testing.T) {
	originalRuntime := utils.Config.Local.Runtime
	originalResolver := resolveContainerIP
	originalIDs := struct {
		kong, pgmeta, logflare string
	}{
		kong:     utils.KongId,
		pgmeta:   utils.PgmetaId,
		logflare: utils.LogflareId,
	}
	t.Cleanup(func() {
		utils.Config.Local.Runtime = originalRuntime
		resolveContainerIP = originalResolver
		utils.KongId = originalIDs.kong
		utils.PgmetaId = originalIDs.pgmeta
		utils.LogflareId = originalIDs.logflare
	})
	utils.Config.Local.Runtime = config.AppleContainerRuntime
	utils.KongId = "test-kong"
	utils.PgmetaId = "test-pgmeta"
	utils.LogflareId = "test-logflare"
	resolveContainerIP = func(_ context.Context, containerId, _ string) (string, error) {
		return map[string]string{
			"test-kong":   "192.168.0.30",
			"test-pgmeta": "192.168.0.31",
		}[containerId], nil
	}

	env, err := buildStudioEnv(
		context.Background(),
		"/tmp/demo",
		pgconn.Config{Host: "192.168.0.2", Port: 5432, Database: "postgres", Password: "postgres"},
		"",
		true,
		true,
		false,
	)
	require.NoError(t, err)

	assert.Contains(t, env, "POSTGRES_HOST=192.168.0.2")
	assert.Contains(t, env, "POSTGRES_PORT=5432")
	assert.Contains(t, env, "POSTGRES_DB=postgres")
	assert.Contains(t, env, "STUDIO_PG_META_URL=http://192.168.0.31:8080")
	assert.Contains(t, env, "SUPABASE_URL=http://192.168.0.30:8000")
	assert.Contains(t, env, "SNIPPETS_MANAGEMENT_FOLDER=")

	foundFunctionsDir := false
	for _, item := range env {
		if strings.HasPrefix(item, "EDGE_FUNCTIONS_MANAGEMENT_FOLDER=") {
			foundFunctionsDir = true
			assert.Contains(t, item, "/tmp/demo/")
		}
	}
	assert.True(t, foundFunctionsDir)
}

func TestBuildVectorConfig(t *testing.T) {
	originalRuntime := utils.Config.Local.Runtime
	originalResolver := resolveContainerIP
	originalIDs := struct {
		vector, logflare, kong, gotrue, rest, realtime, storage, edge, db string
	}{
		vector:   utils.VectorId,
		logflare: utils.LogflareId,
		kong:     utils.KongId,
		gotrue:   utils.GotrueId,
		rest:     utils.RestId,
		realtime: utils.RealtimeId,
		storage:  utils.StorageId,
		edge:     utils.EdgeRuntimeId,
		db:       utils.DbId,
	}
	t.Cleanup(func() {
		utils.Config.Local.Runtime = originalRuntime
		resolveContainerIP = originalResolver
		utils.VectorId = originalIDs.vector
		utils.LogflareId = originalIDs.logflare
		utils.KongId = originalIDs.kong
		utils.GotrueId = originalIDs.gotrue
		utils.RestId = originalIDs.rest
		utils.RealtimeId = originalIDs.realtime
		utils.StorageId = originalIDs.storage
		utils.EdgeRuntimeId = originalIDs.edge
		utils.DbId = originalIDs.db
	})
	utils.VectorId = "test-vector"
	utils.LogflareId = "test-logflare"
	utils.KongId = "test-kong"
	utils.GotrueId = "test-gotrue"
	utils.RestId = "test-rest"
	utils.RealtimeId = "test-realtime"
	utils.StorageId = "test-storage"
	utils.EdgeRuntimeId = "test-edge"
	utils.DbId = "test-db"

	t.Run("uses docker source by default", func(t *testing.T) {
		utils.Config.Local.Runtime = config.DockerRuntime

		cfg, err := buildVectorConfig(context.Background())

		require.NoError(t, err)
		assert.Equal(t, vectorSourceDockerLogs, cfg.SourceType)
		assert.Equal(t, "docker_host", cfg.SourceName)
		assert.Empty(t, cfg.SourceInclude)
		assert.Equal(t, "test-logflare", cfg.LogflareHost)
	})

	t.Run("uses file source and resolved logflare host on apple", func(t *testing.T) {
		utils.Config.Local.Runtime = config.AppleContainerRuntime
		resolveContainerIP = func(_ context.Context, containerId, _ string) (string, error) {
			assert.Equal(t, "test-logflare", containerId)
			return "192.168.0.40", nil
		}

		cfg, err := buildVectorConfig(context.Background())

		require.NoError(t, err)
		assert.Equal(t, vectorSourceFile, cfg.SourceType)
		assert.Equal(t, "apple_logs", cfg.SourceName)
		assert.Equal(t, []string{appleVectorLogGlob}, cfg.SourceInclude)
		assert.Equal(t, "192.168.0.40", cfg.LogflareHost)
	})
}

func TestRenderVectorConfig(t *testing.T) {
	t.Run("renders docker log source", func(t *testing.T) {
		var buf bytes.Buffer
		err := vectorConfigTemplate.Option("missingkey=error").Execute(&buf, vectorConfig{
			ApiKey:        "api-key",
			VectorId:      "test-vector",
			LogflareHost:  "test-logflare",
			KongId:        "test-kong",
			GotrueId:      "test-gotrue",
			RestId:        "test-rest",
			RealtimeId:    "test-realtime",
			StorageId:     "test-storage",
			EdgeRuntimeId: "test-edge",
			DbId:          "test-db",
			SourceName:    "docker_host",
			SourceType:    vectorSourceDockerLogs,
		})
		require.NoError(t, err)
		rendered := buf.String()
		assert.Contains(t, rendered, "docker_host:")
		assert.Contains(t, rendered, "type: docker_logs")
		assert.Contains(t, rendered, "exclude_containers:")
		assert.Contains(t, rendered, "http://test-logflare:4000/api/logs?source_name=gotrue.logs.prod")
	})

	t.Run("renders apple file source", func(t *testing.T) {
		var buf bytes.Buffer
		err := vectorConfigTemplate.Option("missingkey=error").Execute(&buf, vectorConfig{
			ApiKey:        "api-key",
			VectorId:      "test-vector",
			LogflareHost:  "192.168.0.40",
			KongId:        "test-kong",
			GotrueId:      "test-gotrue",
			RestId:        "test-rest",
			RealtimeId:    "test-realtime",
			StorageId:     "test-storage",
			EdgeRuntimeId: "test-edge",
			DbId:          "test-db",
			SourceName:    "apple_logs",
			SourceType:    vectorSourceFile,
			SourceInclude: []string{appleVectorLogGlob},
		})
		require.NoError(t, err)
		rendered := buf.String()
		assert.Contains(t, rendered, "apple_logs:")
		assert.Contains(t, rendered, "type: file")
		assert.Contains(t, rendered, appleVectorLogGlob)
		assert.Contains(t, rendered, "apple_json_logs:")
		assert.Contains(t, rendered, `. = parse_json!(string!(.message))`)
		assert.Contains(t, rendered, "http://192.168.0.40:4000/api/logs?source_name=gotrue.logs.prod")
	})
}

func TestFormatMapForEnvConfig(t *testing.T) {
	t.Run("It produces the correct format and removes the trailing comma", func(t *testing.T) {
		testcases := []struct {
			key      string
			value    string
			expected string
		}{
			{
				key:      "123456",
				value:    "123456",
				expected: `^\w{6}:\w{6}$`,
			},
			{
				key:      "234567",
				value:    "234567",
				expected: `^\w{6}:\w{6},\w{6}:\w{6}$`,
			},
			{
				key:      "345678",
				value:    "345678",
				expected: `^\w{6}:\w{6},\w{6}:\w{6},\w{6}:\w{6}$`,
			},
			{
				key:      "456789",
				value:    "456789",
				expected: `^\w{6}:\w{6},\w{6}:\w{6},\w{6}:\w{6},\w{6}:\w{6}$`,
			},
		}

		output := bytes.Buffer{}
		input := map[string]string{}
		formatMapForEnvConfig(input, &output)
		if len(output.Bytes()) > 0 {
			t.Error("No values should be expected when empty map is provided")
		}

		for _, c := range testcases {
			output.Reset()
			input[c.key] = c.value
			formatMapForEnvConfig(input, &output)
			result := output.String()
			r, err := regexp.Compile(c.expected)
			require.NoError(t, err)
			assert.Regexp(t, r, result)
		}
	})
}
