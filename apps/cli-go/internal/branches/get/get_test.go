package get

import (
	"context"
	"fmt"
	"net/http"
	"testing"

	"github.com/go-errors/errors"
	"github.com/h2non/gock"
	"github.com/oapi-codegen/nullable"
	"github.com/stretchr/testify/assert"
	"github.com/supabase/cli/internal/testing/apitest"
	"github.com/supabase/cli/internal/testing/fstest"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/flags"
	"github.com/supabase/cli/pkg/api"
	"github.com/supabase/cli/pkg/cast"
)

func TestGetBranch(t *testing.T) {
	flags.ProjectRef = apitest.RandomProjectRef()

	t.Run("fetches branch details", func(t *testing.T) {
		t.Cleanup(fstest.MockStdout(t, `
  
   HOST      | PORT | USER   | PASSWORD | JWT SECRET | POSTGRES VERSION             | STATUS         
  -----------|------|--------|----------|------------|------------------------------|----------------
   127.0.0.1 | 5432 | ****** | ******   | ******     | supabase-postgres-17.4.1.074 | ACTIVE_HEALTHY 

`))
		t.Cleanup(apitest.MockPlatformAPI(t))
		// Setup mock api
		gock.New(utils.DefaultApiHost).
			Get("/v1/branches/" + flags.ProjectRef).
			Reply(http.StatusOK).
			JSON(api.BranchDetailResponse{
				DbHost:          "127.0.0.1",
				DbPort:          5432,
				PostgresVersion: "supabase-postgres-17.4.1.074",
				Status:          api.BranchDetailResponseStatusACTIVEHEALTHY,
			})
		// Run test
		err := Run(context.Background(), flags.ProjectRef, nil)
		assert.NoError(t, err)
	})

	t.Run("throws error on network error", func(t *testing.T) {
		errNetwork := errors.New("network error")
		t.Cleanup(apitest.MockPlatformAPI(t))
		// Setup mock api
		gock.New(utils.DefaultApiHost).
			Get("/v1/branches/" + flags.ProjectRef).
			ReplyError(errNetwork)
		// Run test
		err := Run(context.Background(), flags.ProjectRef, nil)
		assert.ErrorIs(t, err, errNetwork)
	})

	t.Run("throws error on service unavailable", func(t *testing.T) {
		t.Cleanup(apitest.MockPlatformAPI(t))
		// Setup mock api
		gock.New(utils.DefaultApiHost).
			Get("/v1/branches/" + flags.ProjectRef).
			Reply(http.StatusServiceUnavailable)
		// Run test
		err := Run(context.Background(), flags.ProjectRef, nil)
		assert.ErrorContains(t, err, "unexpected get branch status 503:")
	})
}

func TestTomlOutput(t *testing.T) {
	flags.ProjectRef = apitest.RandomProjectRef()
	// Setup output format
	utils.OutputFormat.Value = utils.OutputToml
	t.Cleanup(func() { utils.OutputFormat.Value = utils.OutputPretty })

	t.Run("encodes toml format", func(t *testing.T) {
		t.Cleanup(fstest.MockStdout(t, fmt.Sprintf(`POSTGRES_URL = "postgresql://postgres:postgres@127.0.0.1:6543/postgres?connect_timeout=10"
POSTGRES_URL_NON_POOLING = "postgresql://postgres:postgres@127.0.0.1:5432/postgres?connect_timeout=10"
SUPABASE_ANON_KEY = "anon-key"
SUPABASE_JWT_SECRET = "secret-key"
SUPABASE_SERVICE_ROLE_KEY = "service-role-key"
SUPABASE_URL = "https://%s."
`, flags.ProjectRef)))
		t.Cleanup(apitest.MockPlatformAPI(t))
		// Setup mock api
		gock.New(utils.DefaultApiHost).
			Get("/v1/branches/" + flags.ProjectRef).
			Reply(http.StatusOK).
			JSON(api.BranchDetailResponse{
				DbHost:    "127.0.0.1",
				DbPort:    5432,
				DbUser:    cast.Ptr("postgres"),
				DbPass:    cast.Ptr("postgres"),
				JwtSecret: cast.Ptr("secret-key"),
				Ref:       flags.ProjectRef,
			})
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + flags.ProjectRef + "/api-keys").
			Reply(http.StatusOK).
			JSON([]api.ApiKeyResponse{{
				Name:   "anon",
				ApiKey: nullable.NewNullableWithValue("anon-key"),
			}, {
				Name:   "service_role",
				ApiKey: nullable.NewNullableWithValue("service-role-key"),
			}})
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + flags.ProjectRef + "/config/database/pooler").
			Reply(http.StatusOK).
			JSON([]api.SupavisorConfigResponse{{
				ConnectionString: "postgres://postgres:postgres@127.0.0.1:6543/postgres",
				DatabaseType:     api.SupavisorConfigResponseDatabaseTypePRIMARY,
				PoolMode:         api.SupavisorConfigResponsePoolModeTransaction,
			}})
		// Run test
		err := Run(context.Background(), flags.ProjectRef, nil)
		assert.NoError(t, err)
	})

	t.Run("throws error on network error", func(t *testing.T) {
		errNetwork := errors.New("network error")
		t.Cleanup(apitest.MockPlatformAPI(t))
		// Setup mock api
		gock.New(utils.DefaultApiHost).
			Get("/v1/branches/" + flags.ProjectRef).
			Reply(http.StatusOK).
			JSON(api.BranchDetailResponse{
				Ref: flags.ProjectRef,
			})
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + flags.ProjectRef + "/api-keys").
			ReplyError(errNetwork)
		// Run test
		err := Run(context.Background(), flags.ProjectRef, nil)
		assert.ErrorIs(t, err, errNetwork)
	})

	t.Run("throws error on database not found", func(t *testing.T) {
		t.Cleanup(apitest.MockPlatformAPI(t))
		// Setup mock api
		gock.New(utils.DefaultApiHost).
			Get("/v1/branches/" + flags.ProjectRef).
			Reply(http.StatusOK).
			JSON(api.BranchDetailResponse{
				Ref: flags.ProjectRef,
			})
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + flags.ProjectRef + "/api-keys").
			Reply(http.StatusOK).
			JSON([]api.ApiKeyResponse{})
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + flags.ProjectRef + "/config/database/pooler").
			Reply(http.StatusOK).
			JSON([]api.SupavisorConfigResponse{})
		// Run test
		err := Run(context.Background(), flags.ProjectRef, nil)
		assert.ErrorIs(t, err, utils.ErrPrimaryNotFound)
	})
}

func TestBranchDetail(t *testing.T) {
	flags.ProjectRef = apitest.RandomProjectRef()

	t.Run("get branch by name", func(t *testing.T) {
		t.Cleanup(apitest.MockPlatformAPI(t))
		// Setup mock api
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + flags.ProjectRef + "/branches/main").
			Reply(http.StatusOK).
			JSON(api.BranchResponse{ProjectRef: flags.ProjectRef})
		gock.New(utils.DefaultApiHost).
			Get("/v1/branches/" + flags.ProjectRef).
			Reply(http.StatusOK).
			JSON(api.BranchDetailResponse{})
		// Run test
		_, err := getBranchDetail(context.Background(), "main")
		assert.NoError(t, err)
	})

	t.Run("throws error on network error", func(t *testing.T) {
		errNetwork := errors.New("network error")
		t.Cleanup(apitest.MockPlatformAPI(t))
		// Setup mock api
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + flags.ProjectRef + "/branches/main").
			ReplyError(errNetwork)
		// Run test
		_, err := getBranchDetail(context.Background(), "main")
		assert.ErrorIs(t, err, errNetwork)
	})

	t.Run("throws error on branch not found", func(t *testing.T) {
		t.Cleanup(apitest.MockPlatformAPI(t))
		// Setup mock api
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + flags.ProjectRef + "/branches/missing").
			Reply(http.StatusNotFound)
		// Run test
		_, err := getBranchDetail(context.Background(), "missing")
		assert.ErrorContains(t, err, "unexpected find branch status 404:")
	})
}
