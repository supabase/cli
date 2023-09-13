package link

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"

	"github.com/jackc/pgconn"
	"github.com/jackc/pgerrcode"
	"github.com/jackc/pgx/v4"
	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/migration/repair"
	"github.com/supabase/cli/internal/testing/apitest"
	"github.com/supabase/cli/internal/testing/pgtest"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/tenant"
	"github.com/supabase/cli/pkg/api"
	"github.com/zalando/go-keyring"
	"gopkg.in/h2non/gock.v1"
)

var dbConfig = pgconn.Config{
	Host:     "localhost",
	Port:     5432,
	User:     "admin",
	Password: "password",
	Database: "postgres",
}

func TestPreRun(t *testing.T) {
	// Reset global variable
	copy := utils.Config
	teardown := func() {
		utils.Config = copy
	}

	t.Run("passes sanity check", func(t *testing.T) {
		defer teardown()
		project := apitest.RandomProjectRef()
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, utils.WriteConfig(fsys, false))
		// Run test
		err := PreRun(project, fsys)
		// Check error
		assert.NoError(t, err)
	})

	t.Run("throws error on invalid project ref", func(t *testing.T) {
		defer teardown()
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Run test
		err := PreRun("malformed", fsys)
		// Check error
		assert.ErrorIs(t, err, utils.ErrInvalidRef)
	})

	t.Run("throws error on missing config", func(t *testing.T) {
		defer teardown()
		project := apitest.RandomProjectRef()
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Run test
		err := PreRun(project, fsys)
		// Check error
		assert.ErrorIs(t, err, os.ErrNotExist)
	})
}

// Reset global variable
func teardown() {
	updatedConfig.Api = nil
	updatedConfig.Db = nil
	updatedConfig.Pooler = nil
}

func TestPostRun(t *testing.T) {
	t.Run("prints completion message", func(t *testing.T) {
		defer teardown()
		project := "test-project"
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Run test
		buf := &strings.Builder{}
		err := PostRun(project, buf, fsys)
		// Check error
		assert.NoError(t, err)
		assert.Equal(t, "Finished supabase link.\n", buf.String())
	})

	t.Run("prints changed config", func(t *testing.T) {
		defer teardown()
		project := "test-project"
		updatedConfig.Api = "test"
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Run test
		buf := &strings.Builder{}
		err := PostRun(project, buf, fsys)
		// Check error
		assert.NoError(t, err)
		assert.Contains(t, buf.String(), `api = "test"`)
	})
}

func TestLinkCommand(t *testing.T) {
	project := "test-project"
	// Setup valid access token
	token := apitest.RandomAccessToken(t)
	t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))
	// Mock credentials store
	keyring.MockInit()

	t.Run("link valid project", func(t *testing.T) {
		defer teardown()
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(repair.CREATE_VERSION_SCHEMA).
			Reply("CREATE SCHEMA").
			Query(repair.CREATE_VERSION_TABLE).
			Reply("CREATE TABLE").
			Query(repair.ADD_STATEMENTS_COLUMN).
			Reply("ALTER TABLE").
			Query(repair.ADD_NAME_COLUMN).
			Reply("ALTER TABLE")
		// Flush pending mocks after test execution
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + project + "/postgrest").
			Reply(200).
			JSON(api.PostgrestConfigResponse{})
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + project + "/config/database/pgbouncer").
			Reply(200).
			JSON(api.V1PgbouncerConfigResponse{})
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + project + "/api-keys").
			Reply(200).
			JSON([]api.ApiKeyResponse{{ApiKey: "anon-key"}})
		rest := tenant.SwaggerResponse{Info: tenant.SwaggerInfo{Version: "11.1.0"}}
		gock.New(fmt.Sprintf("https://%s.supabase.co", project)).
			Get("/rest/v1/").
			Reply(200).
			JSON(rest)
		auth := tenant.HealthResponse{Version: "v2.74.2"}
		gock.New(fmt.Sprintf("https://%s.supabase.co", project)).
			Get("/auth/v1/health").
			Reply(200).
			JSON(auth)
		// Run test
		err := Run(context.Background(), project, dbConfig.Password, fsys, conn.Intercept)
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
	})

	t.Run("throws error on network failure", func(t *testing.T) {
		t.Skip()
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Flush pending mocks after test execution
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + project + "/api-keys").
			ReplyError(errors.New("network error"))
		// Run test
		err := Run(context.Background(), project, dbConfig.Password, fsys)
		// Check error
		assert.ErrorContains(t, err, "network error")
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("ignores error linking services", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Flush pending mocks after test execution
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + project + "/api-keys").
			Reply(200).
			JSON([]api.ApiKeyResponse{{ApiKey: "anon-key"}})
		// Link configs
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + project + "/postgrest").
			ReplyError(errors.New("network error"))
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + project + "/config/database/pgbouncer").
			ReplyError(errors.New("network error"))
		// Link versions
		gock.New(fmt.Sprintf("https://%s.supabase.co", project)).
			Get("/auth/v1/health").
			ReplyError(errors.New("network error"))
		gock.New(fmt.Sprintf("https://%s.supabase.co", project)).
			Get("/rest/v1/").
			ReplyError(errors.New("network error"))
		// Run test
		err := Run(context.Background(), project, dbConfig.Password, fsys, func(cc *pgx.ConnConfig) {
			cc.LookupFunc = func(ctx context.Context, host string) (addrs []string, err error) {
				return nil, errors.New("hostname resolving error")
			}
		})
		// Check error
		assert.ErrorContains(t, err, "hostname resolving error")
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on write failure", func(t *testing.T) {
		defer teardown()
		// Setup in-memory fs
		fsys := afero.NewReadOnlyFs(afero.NewMemMapFs())
		// Flush pending mocks after test execution
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + project + "/api-keys").
			Reply(200).
			JSON([]api.ApiKeyResponse{{ApiKey: "anon-key"}})
		// Link configs
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + project + "/postgrest").
			ReplyError(errors.New("network error"))
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + project + "/config/database/pgbouncer").
			ReplyError(errors.New("network error"))
		// Link versions
		gock.New(fmt.Sprintf("https://%s.supabase.co", project)).
			Get("/auth/v1/health").
			ReplyError(errors.New("network error"))
		gock.New(fmt.Sprintf("https://%s.supabase.co", project)).
			Get("/rest/v1/").
			ReplyError(errors.New("network error"))
		// Run test
		err := Run(context.Background(), project, "", fsys)
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
		defer teardown()
		// Flush pending mocks after test execution
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + project + "/postgrest").
			Reply(200).
			JSON(api.PostgrestConfigResponse{})
		// Run test
		err := linkPostgrest(context.Background(), project)
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, apitest.ListUnmatchedRequests())
		assert.Empty(t, updatedConfig)
	})

	t.Run("updates api on newer config", func(t *testing.T) {
		defer teardown()
		// Flush pending mocks after test execution
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + project + "/postgrest").
			Reply(200).
			JSON(api.PostgrestConfigResponse{
				DbSchema:          "public, storage, graphql_public",
				DbExtraSearchPath: "public, extensions",
				MaxRows:           1000,
			})
		// Run test
		err := linkPostgrest(context.Background(), project)
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, apitest.ListUnmatchedRequests())
		utils.Config.Api.Schemas = []string{"public", "storage", "graphql_public"}
		utils.Config.Api.ExtraSearchPath = []string{"public", "extensions"}
		utils.Config.Api.MaxRows = 1000
		assert.Equal(t, ConfigCopy{
			Api: utils.Config.Api,
		}, updatedConfig)
	})

	t.Run("throws error on network failure", func(t *testing.T) {
		defer teardown()
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
		defer teardown()
		// Flush pending mocks after test execution
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + project + "/postgrest").
			Reply(500).
			JSON(map[string]string{"message": "unavailable"})
		// Run test
		err := linkPostgrest(context.Background(), project)
		// Validate api
		assert.ErrorContains(t, err, `Authorization failed for the access token and project ref pair: {"message":"unavailable"}`)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}

func TestLinkDatabase(t *testing.T) {
	t.Run("throws error on connect failure", func(t *testing.T) {
		defer teardown()
		// Run test
		err := linkDatabase(context.Background(), pgconn.Config{})
		// Check error
		assert.ErrorContains(t, err, "invalid port (outside range)")
		assert.Empty(t, updatedConfig)
	})

	t.Run("ignores missing server version", func(t *testing.T) {
		defer teardown()
		// Setup mock postgres
		conn := pgtest.NewWithStatus(map[string]string{
			"standard_conforming_strings": "on",
		})
		defer conn.Close(t)
		conn.Query(repair.CREATE_VERSION_SCHEMA).
			Reply("CREATE SCHEMA").
			Query(repair.CREATE_VERSION_TABLE).
			Reply("CREATE TABLE").
			Query(repair.ADD_STATEMENTS_COLUMN).
			Reply("ALTER TABLE").
			Query(repair.ADD_NAME_COLUMN).
			Reply("ALTER TABLE")
		// Run test
		err := linkDatabase(context.Background(), dbConfig, conn.Intercept)
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, updatedConfig)
	})

	t.Run("updates config to newer db version", func(t *testing.T) {
		defer teardown()
		utils.Config.Db.MajorVersion = 14
		// Setup mock postgres
		conn := pgtest.NewWithStatus(map[string]string{
			"standard_conforming_strings": "on",
			"server_version":              "15.0",
		})
		defer conn.Close(t)
		conn.Query(repair.CREATE_VERSION_SCHEMA).
			Reply("CREATE SCHEMA").
			Query(repair.CREATE_VERSION_TABLE).
			Reply("CREATE TABLE").
			Query(repair.ADD_STATEMENTS_COLUMN).
			Reply("ALTER TABLE").
			Query(repair.ADD_NAME_COLUMN).
			Reply("ALTER TABLE")
		// Run test
		err := linkDatabase(context.Background(), dbConfig, conn.Intercept)
		// Check error
		assert.NoError(t, err)
		utils.Config.Db.MajorVersion = 15
		assert.Equal(t, ConfigCopy{
			Db: utils.Config.Db,
		}, updatedConfig)
	})

	t.Run("throws error on query failure", func(t *testing.T) {
		defer teardown()
		utils.Config.Db.MajorVersion = 14
		// Setup mock postgres
		conn := pgtest.NewConn()
		defer conn.Close(t)
		conn.Query(repair.CREATE_VERSION_SCHEMA).
			Reply("CREATE SCHEMA").
			Query(repair.CREATE_VERSION_TABLE).
			ReplyError(pgerrcode.InsufficientPrivilege, "permission denied for relation supabase_migrations").
			Query(repair.ADD_STATEMENTS_COLUMN).
			Query(repair.ADD_NAME_COLUMN)
		// Run test
		err := linkDatabase(context.Background(), dbConfig, conn.Intercept)
		// Check error
		assert.ErrorContains(t, err, "ERROR: permission denied for relation supabase_migrations (SQLSTATE 42501)")
	})
}
