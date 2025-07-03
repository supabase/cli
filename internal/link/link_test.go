package link

import (
	"context"
	"errors"
	"net/http"
	"testing"

	"github.com/h2non/gock"
	"github.com/jackc/pgconn"
	"github.com/jackc/pgerrcode"
	"github.com/jackc/pgx/v4"
	"github.com/oapi-codegen/nullable"
	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/supabase/cli/internal/testing/apitest"
	"github.com/supabase/cli/internal/testing/fstest"
	"github.com/supabase/cli/internal/testing/helper"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/tenant"
	"github.com/supabase/cli/pkg/api"
	"github.com/supabase/cli/pkg/migration"
	"github.com/supabase/cli/pkg/pgtest"
	"github.com/zalando/go-keyring"
)

var dbConfig = pgconn.Config{
	Host:     "127.0.0.1",
	Port:     5432,
	User:     "admin",
	Password: "password",
	Database: "postgres",
}

func TestLinkCommand(t *testing.T) {
	project := "test-project"
	// Setup valid access token
	token := apitest.RandomAccessToken(t)
	t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))
	// Mock credentials store
	keyring.MockInit()

	t.Run("link valid project", func(t *testing.T) {
		t.Cleanup(fstest.MockStdin(t, "\n"))
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(GET_LATEST_STORAGE_MIGRATION).
			Reply("SELECT 1", []interface{}{"custom-metadata"})
		helper.MockMigrationHistory(conn)
		helper.MockSeedHistory(conn)
		// Flush pending mocks after test execution
		defer gock.OffAll()
		// Mock project status
		mockPostgres := api.V1ProjectWithDatabaseResponse{
			Status: api.V1ProjectWithDatabaseResponseStatusACTIVEHEALTHY,
		}
		mockPostgres.Database.Host = utils.GetSupabaseDbHost(project)
		mockPostgres.Database.Version = "15.1.0.117"
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + project).
			Reply(200).
			JSON(mockPostgres)
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + project + "/api-keys").
			Reply(200).
			JSON([]api.ApiKeyResponse{{Name: "anon", ApiKey: nullable.NewNullableWithValue("anon-key")}})
		// Link configs
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + project + "/config/database/postgres").
			Reply(200).
			JSON(api.PostgresConfigResponse{})
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + project + "/postgrest").
			Reply(200).
			JSON(api.V1PostgrestConfigResponse{})
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + project + "/config/auth").
			Reply(200).
			JSON(api.AuthConfigResponse{})
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + project + "/config/storage").
			Reply(200).
			JSON(api.StorageConfigResponse{})
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + project + "/config/database/pooler").
			Reply(200).
			JSON(api.V1PgbouncerConfigResponse{})
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + project + "/network-restrictions").
			Reply(200).
			JSON(api.NetworkRestrictionsResponse{})
		// Link versions
		auth := tenant.HealthResponse{Version: "v2.74.2"}
		gock.New("https://" + utils.GetSupabaseHost(project)).
			Get("/auth/v1/health").
			Reply(200).
			JSON(auth)
		rest := tenant.SwaggerResponse{Info: tenant.SwaggerInfo{Version: "11.1.0"}}
		gock.New("https://" + utils.GetSupabaseHost(project)).
			Get("/rest/v1/").
			Reply(200).
			JSON(rest)
		// Run test
		err := Run(context.Background(), project, fsys, conn.Intercept)
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, apitest.ListUnmatchedRequests())
		// Validate file contents
		content, err := afero.ReadFile(fsys, utils.ProjectRefPath)
		assert.NoError(t, err)
		assert.Equal(t, []byte(project), content)
		restVersion, err := afero.ReadFile(fsys, utils.RestVersionPath)
		assert.NoError(t, err)
		assert.Equal(t, []byte("v"+rest.Info.Version), restVersion)
		authVersion, err := afero.ReadFile(fsys, utils.GotrueVersionPath)
		assert.NoError(t, err)
		assert.Equal(t, []byte(auth.Version), authVersion)
		postgresVersion, err := afero.ReadFile(fsys, utils.PostgresVersionPath)
		assert.NoError(t, err)
		assert.Equal(t, []byte(mockPostgres.Database.Version), postgresVersion)
	})

	t.Run("ignores error linking services", func(t *testing.T) {
		t.Cleanup(fstest.MockStdin(t, "\n"))
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Flush pending mocks after test execution
		defer gock.OffAll()
		// Mock project status
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + project).
			Reply(200).
			JSON(api.V1ProjectWithDatabaseResponse{
				Status: api.V1ProjectWithDatabaseResponseStatusACTIVEHEALTHY,
			})
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + project + "/api-keys").
			Reply(200).
			JSON([]api.ApiKeyResponse{{Name: "anon", ApiKey: nullable.NewNullableWithValue("anon-key")}})
		// Link configs
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + project + "/config/database/postgres").
			ReplyError(errors.New("network error"))
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + project + "/postgrest").
			ReplyError(errors.New("network error"))
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + project + "/config/auth").
			ReplyError(errors.New("network error"))
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + project + "/config/storage").
			ReplyError(errors.New("network error"))
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + project + "/config/database/pooler").
			ReplyError(errors.New("network error"))
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + project + "/network-restrictions").
			Reply(200).
			JSON(api.NetworkRestrictionsResponse{})
		// Link versions
		gock.New("https://" + utils.GetSupabaseHost(project)).
			Get("/auth/v1/health").
			ReplyError(errors.New("network error"))
		gock.New("https://" + utils.GetSupabaseHost(project)).
			Get("/rest/v1/").
			ReplyError(errors.New("network error"))
		// Run test
		err := Run(context.Background(), project, fsys, func(cc *pgx.ConnConfig) {
			cc.LookupFunc = func(ctx context.Context, host string) (addrs []string, err error) {
				return nil, errors.New("hostname resolving error")
			}
		})
		// Check error
		assert.ErrorContains(t, err, "hostname resolving error")
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on write failure", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewReadOnlyFs(afero.NewMemMapFs())
		// Flush pending mocks after test execution
		defer gock.OffAll()
		// Mock project status
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + project).
			Reply(200).
			JSON(api.V1ProjectWithDatabaseResponse{
				Status: api.V1ProjectWithDatabaseResponseStatusACTIVEHEALTHY,
			})
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + project + "/api-keys").
			Reply(200).
			JSON([]api.ApiKeyResponse{{Name: "anon", ApiKey: nullable.NewNullableWithValue("anon-key")}})
		// Link configs
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + project + "/config/database/postgres").
			ReplyError(errors.New("network error"))
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + project + "/postgrest").
			ReplyError(errors.New("network error"))
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + project + "/config/auth").
			ReplyError(errors.New("network error"))
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + project + "/config/storage").
			ReplyError(errors.New("network error"))
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + project + "/config/database/pooler").
			ReplyError(errors.New("network error"))
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + project + "/network-restrictions").
			Reply(200).
			JSON(api.NetworkRestrictionsResponse{})
		// Link versions
		gock.New("https://" + utils.GetSupabaseHost(project)).
			Get("/auth/v1/health").
			ReplyError(errors.New("network error"))
		gock.New("https://" + utils.GetSupabaseHost(project)).
			Get("/rest/v1/").
			ReplyError(errors.New("network error"))
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects").
			ReplyError(errors.New("network error"))
		// Run test
		err := Run(context.Background(), project, fsys)
		// Check error
		assert.ErrorContains(t, err, "operation not permitted")
		assert.Empty(t, apitest.ListUnmatchedRequests())
		// Validate file contents
		exists, err := afero.Exists(fsys, utils.ProjectRefPath)
		assert.NoError(t, err)
		assert.False(t, exists)
	})
}

func TestStatusCheck(t *testing.T) {
	project := "test-project"
	token := apitest.RandomAccessToken(t)
	t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))

	t.Run("updates postgres version when healthy", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Flush pending mocks after test execution
		defer gock.OffAll()
		postgres := api.V1ProjectWithDatabaseResponse{
			Status: api.V1ProjectWithDatabaseResponseStatusACTIVEHEALTHY,
		}
		postgres.Database.Version = "15.6.1.139"
		// Mock project status
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + project).
			Reply(http.StatusOK).
			JSON(postgres)
		// Run test
		err := checkRemoteProjectStatus(context.Background(), project, fsys)
		// Check error
		assert.NoError(t, err)
		version, err := afero.ReadFile(fsys, utils.PostgresVersionPath)
		assert.NoError(t, err)
		assert.Equal(t, "15.6.1.139", string(version))
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("ignores project not found", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Flush pending mocks after test execution
		defer gock.OffAll()
		// Mock project status
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + project).
			Reply(http.StatusNotFound)
		// Run test
		err := checkRemoteProjectStatus(context.Background(), project, fsys)
		// Check error
		assert.NoError(t, err)
		exists, err := afero.Exists(fsys, utils.PostgresVersionPath)
		assert.NoError(t, err)
		assert.False(t, exists)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on project inactive", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Flush pending mocks after test execution
		defer gock.OffAll()
		// Mock project status
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + project).
			Reply(http.StatusOK).
			JSON(api.V1ProjectWithDatabaseResponse{Status: api.V1ProjectWithDatabaseResponseStatusINACTIVE})
		// Run test
		err := checkRemoteProjectStatus(context.Background(), project, fsys)
		// Check error
		assert.ErrorIs(t, err, errProjectPaused)
		exists, err := afero.Exists(fsys, utils.PostgresVersionPath)
		assert.NoError(t, err)
		assert.False(t, exists)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}

func TestLinkPostgrest(t *testing.T) {
	project := "test-project"
	// Setup valid access token
	token := apitest.RandomAccessToken(t)
	t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))

	t.Run("ignores matching config", func(t *testing.T) {
		// Flush pending mocks after test execution
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + project + "/postgrest").
			Reply(200).
			JSON(api.V1PostgrestConfigResponse{})
		// Run test
		err := linkPostgrest(context.Background(), project)
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("updates api on newer config", func(t *testing.T) {
		// Flush pending mocks after test execution
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + project + "/postgrest").
			Reply(200).
			JSON(api.V1PostgrestConfigResponse{
				DbSchema:          "public, graphql_public",
				DbExtraSearchPath: "public, extensions",
				MaxRows:           1000,
			})
		// Run test
		err := linkPostgrest(context.Background(), project)
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, apitest.ListUnmatchedRequests())
		assert.ElementsMatch(t, []string{"public", "graphql_public"}, utils.Config.Api.Schemas)
		assert.ElementsMatch(t, []string{"public", "extensions"}, utils.Config.Api.ExtraSearchPath)
		assert.Equal(t, uint(1000), utils.Config.Api.MaxRows)
	})

	t.Run("throws error on network failure", func(t *testing.T) {
		// Flush pending mocks after test execution
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + project + "/postgrest").
			ReplyError(errors.New("network error"))
		// Run test
		err := linkPostgrest(context.Background(), project)
		// Validate api
		assert.ErrorContains(t, err, "network error")
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on server unavailable", func(t *testing.T) {
		// Flush pending mocks after test execution
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + project + "/postgrest").
			Reply(500).
			JSON(map[string]string{"message": "unavailable"})
		// Run test
		err := linkPostgrest(context.Background(), project)
		// Validate api
		assert.ErrorContains(t, err, `unexpected API config status 500: {"message":"unavailable"}`)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}

func TestLinkDatabase(t *testing.T) {
	t.Run("throws error on connect failure", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Run test
		err := linkDatabase(context.Background(), pgconn.Config{}, fsys)
		// Check error
		assert.ErrorContains(t, err, "invalid port (outside range)")
	})

	t.Run("ignores missing server version", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup mock postgres
		conn := pgtest.NewWithStatus(map[string]string{
			"standard_conforming_strings": "on",
		})
		defer conn.Close(t)
		conn.Query(GET_LATEST_STORAGE_MIGRATION).
			Reply("SELECT 1", []interface{}{"custom-metadata"})
		helper.MockMigrationHistory(conn)
		helper.MockSeedHistory(conn)
		// Run test
		err := linkDatabase(context.Background(), dbConfig, fsys, conn.Intercept)
		// Check error
		assert.NoError(t, err)
		version, err := afero.ReadFile(fsys, utils.StorageVersionPath)
		assert.NoError(t, err)
		assert.Equal(t, "custom-metadata", string(version))
	})

	t.Run("updates config to newer db version", func(t *testing.T) {
		utils.Config.Db.MajorVersion = 14
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup mock postgres
		conn := pgtest.NewWithStatus(map[string]string{
			"standard_conforming_strings": "on",
			"server_version":              "15.0",
		})
		defer conn.Close(t)
		conn.Query(GET_LATEST_STORAGE_MIGRATION).
			Reply("SELECT 1", []interface{}{"custom-metadata"})
		helper.MockMigrationHistory(conn)
		helper.MockSeedHistory(conn)
		// Run test
		err := linkDatabase(context.Background(), dbConfig, fsys, conn.Intercept)
		// Check error
		assert.NoError(t, err)
		assert.Equal(t, uint(15), utils.Config.Db.MajorVersion)
		version, err := afero.ReadFile(fsys, utils.StorageVersionPath)
		assert.NoError(t, err)
		assert.Equal(t, "custom-metadata", string(version))
	})

	t.Run("throws error on query failure", func(t *testing.T) {
		utils.Config.Db.MajorVersion = 14
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(GET_LATEST_STORAGE_MIGRATION).
			ReplyError(pgerrcode.InsufficientPrivilege, "permission denied for relation migrations").
			Query(migration.SET_LOCK_TIMEOUT).
			Query(migration.CREATE_VERSION_SCHEMA).
			Reply("CREATE SCHEMA").
			Query(migration.CREATE_VERSION_TABLE).
			ReplyError(pgerrcode.InsufficientPrivilege, "permission denied for relation supabase_migrations").
			Query(migration.ADD_STATEMENTS_COLUMN).
			Query(migration.ADD_NAME_COLUMN)
		// Run test
		err := linkDatabase(context.Background(), dbConfig, fsys, conn.Intercept)
		// Check error
		assert.ErrorContains(t, err, "ERROR: permission denied for relation supabase_migrations (SQLSTATE 42501)")
		exists, err := afero.Exists(fsys, utils.StorageVersionPath)
		assert.NoError(t, err)
		assert.False(t, exists)
	})
}
