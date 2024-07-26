package link

import (
	"context"
	"errors"
	"testing"

	"github.com/h2non/gock"
	"github.com/jackc/pgconn"
	"github.com/jackc/pgerrcode"
	"github.com/jackc/pgx/v4"
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
		helper.MockMigrationHistory(conn)
		// Flush pending mocks after test execution
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + project + "/api-keys").
			Reply(200).
			JSON([]api.ApiKeyResponse{{Name: "anon", ApiKey: "anon-key"}})
		// Link configs
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + project + "/postgrest").
			Reply(200).
			JSON(api.V1PostgrestConfigResponse{})
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + project + "/config/database/pooler").
			Reply(200).
			JSON(api.V1PgbouncerConfigResponse{})
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
		gock.New("https://" + utils.GetSupabaseHost(project)).
			Get("/storage/v1/version").
			Reply(200).
			BodyString("0.40.4")
		postgres := api.V1DatabaseResponse{
			Host:    utils.GetSupabaseDbHost(project),
			Version: "15.1.0.117",
		}
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects").
			Reply(200).
			JSON([]api.V1ProjectResponse{
				{
					Id:             project,
					Database:       &postgres,
					OrganizationId: "combined-fuchsia-lion",
					Name:           "Test Project",
					Region:         "us-west-1",
					CreatedAt:      "2022-04-25T02:14:55.906498Z",
				},
			})
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
		assert.Equal(t, []byte(postgres.Version), postgresVersion)
	})

	t.Run("ignores error linking services", func(t *testing.T) {
		t.Cleanup(fstest.MockStdin(t, "\n"))
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Flush pending mocks after test execution
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + project + "/api-keys").
			Reply(200).
			JSON([]api.ApiKeyResponse{{Name: "anon", ApiKey: "anon-key"}})
		// Link configs
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + project + "/postgrest").
			ReplyError(errors.New("network error"))
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + project + "/config/database/pooler").
			ReplyError(errors.New("network error"))
		// Link versions
		gock.New("https://" + utils.GetSupabaseHost(project)).
			Get("/auth/v1/health").
			ReplyError(errors.New("network error"))
		gock.New("https://" + utils.GetSupabaseHost(project)).
			Get("/rest/v1/").
			ReplyError(errors.New("network error"))
		gock.New("https://" + utils.GetSupabaseHost(project)).
			Get("/storage/v1/version").
			ReplyError(errors.New("network error"))
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects").
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
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + project + "/api-keys").
			Reply(200).
			JSON([]api.ApiKeyResponse{{Name: "anon", ApiKey: "anon-key"}})
		// Link configs
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + project + "/postgrest").
			ReplyError(errors.New("network error"))
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + project + "/config/database/pooler").
			ReplyError(errors.New("network error"))
		// Link versions
		gock.New("https://" + utils.GetSupabaseHost(project)).
			Get("/auth/v1/health").
			ReplyError(errors.New("network error"))
		gock.New("https://" + utils.GetSupabaseHost(project)).
			Get("/rest/v1/").
			ReplyError(errors.New("network error"))
		gock.New("https://" + utils.GetSupabaseHost(project)).
			Get("/storage/v1/version").
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
		assert.ErrorIs(t, err, tenant.ErrAuthToken)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}

func TestLinkDatabase(t *testing.T) {
	t.Run("throws error on connect failure", func(t *testing.T) {
		// Run test
		err := linkDatabase(context.Background(), pgconn.Config{})
		// Check error
		assert.ErrorContains(t, err, "invalid port (outside range)")
	})

	t.Run("ignores missing server version", func(t *testing.T) {
		// Setup mock postgres
		conn := pgtest.NewWithStatus(map[string]string{
			"standard_conforming_strings": "on",
		})
		defer conn.Close(t)
		helper.MockMigrationHistory(conn)
		// Run test
		err := linkDatabase(context.Background(), dbConfig, conn.Intercept)
		// Check error
		assert.NoError(t, err)
	})

	t.Run("updates config to newer db version", func(t *testing.T) {
		utils.Config.Db.MajorVersion = 14
		// Setup mock postgres
		conn := pgtest.NewWithStatus(map[string]string{
			"standard_conforming_strings": "on",
			"server_version":              "15.0",
		})
		defer conn.Close(t)
		helper.MockMigrationHistory(conn)
		// Run test
		err := linkDatabase(context.Background(), dbConfig, conn.Intercept)
		// Check error
		assert.NoError(t, err)
		utils.Config.Db.MajorVersion = 15
		assert.Equal(t, uint(15), utils.Config.Db.MajorVersion)
	})

	t.Run("throws error on query failure", func(t *testing.T) {
		utils.Config.Db.MajorVersion = 14
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(migration.SET_LOCK_TIMEOUT).
			Query(migration.CREATE_VERSION_SCHEMA).
			Reply("CREATE SCHEMA").
			Query(migration.CREATE_VERSION_TABLE).
			ReplyError(pgerrcode.InsufficientPrivilege, "permission denied for relation supabase_migrations").
			Query(migration.ADD_STATEMENTS_COLUMN).
			Query(migration.ADD_NAME_COLUMN)
		// Run test
		err := linkDatabase(context.Background(), dbConfig, conn.Intercept)
		// Check error
		assert.ErrorContains(t, err, "ERROR: permission denied for relation supabase_migrations (SQLSTATE 42501)")
	})
}
