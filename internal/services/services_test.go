package services

import (
	"context"
	"net/http"
	"testing"

	"github.com/h2non/gock"
	"github.com/oapi-codegen/nullable"
	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/supabase/cli/internal/testing/apitest"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/flags"
	"github.com/supabase/cli/internal/utils/tenant"
	"github.com/supabase/cli/pkg/api"
)

func TestServicesCommand(t *testing.T) {
	t.Run("output pretty", func(t *testing.T) {
		utils.OutputFormat.Value = utils.OutputPretty
		// Run test
		err := Run(context.Background(), afero.NewMemMapFs())
		// Check error
		assert.NoError(t, err)
	})

	t.Run("output toml", func(t *testing.T) {
		utils.OutputFormat.Value = utils.OutputToml
		// Run test
		err := Run(context.Background(), afero.NewMemMapFs())
		// Check error
		assert.NoError(t, err)
	})

	t.Run("output json", func(t *testing.T) {
		utils.OutputFormat.Value = utils.OutputJson
		// Run test
		err := Run(context.Background(), afero.NewMemMapFs())
		// Check error
		assert.NoError(t, err)
	})

	t.Run("output env", func(t *testing.T) {
		utils.OutputFormat.Value = utils.OutputEnv
		// Run test
		err := Run(context.Background(), afero.NewMemMapFs())
		// Check error
		assert.ErrorIs(t, err, utils.ErrEnvNotSupported)
	})
}

func TestCheckVersions(t *testing.T) {
	// Setup valid access token
	token := apitest.RandomAccessToken(t)
	t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))
	// Setup valid project ref
	flags.ProjectRef = apitest.RandomProjectRef()
	projectHost := "https://" + utils.GetSupabaseHost(flags.ProjectRef)
	// Setup mock project
	mockProject := api.V1ProjectWithDatabaseResponse{}
	mockProject.Database.Version = "14.1.0.99"

	t.Run("diff service versions", func(t *testing.T) {
		// Setup mock api
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + flags.ProjectRef + "/api-keys").
			Reply(http.StatusOK).
			JSON([]api.ApiKeyResponse{{
				Name:   "service_role",
				ApiKey: nullable.NewNullableWithValue("service-key"),
			}})
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + flags.ProjectRef).
			Reply(http.StatusOK).
			JSON(mockProject)
		// Mock service versions
		gock.New(projectHost).
			Get("/auth/v1/health").
			Reply(http.StatusOK).
			JSON(tenant.HealthResponse{Version: "v2.74.2"})
		gock.New(projectHost).
			Get("/rest/v1/").
			Reply(http.StatusOK).
			JSON(tenant.SwaggerResponse{Info: tenant.SwaggerInfo{Version: "11.1.0"}})
		gock.New(projectHost).
			Get("/storage/v1/version").
			Reply(http.StatusOK).
			BodyString("1.28.0")
		// Run test
		images := CheckVersions(context.Background(), afero.NewMemMapFs())
		// Check error
		assert.Equal(t, len(images), 10)
		for _, img := range images {
			assert.NotEqual(t, img.Local, img.Remote)
		}
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("list remote images", func(t *testing.T) {
		// Setup mock api
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + flags.ProjectRef + "/api-keys").
			Reply(http.StatusOK).
			JSON([]api.ApiKeyResponse{{
				Name:   "service_role",
				ApiKey: nullable.NewNullableWithValue("service-key"),
			}})
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + flags.ProjectRef).
			Reply(http.StatusOK).
			JSON(mockProject)
		// Mock service versions
		gock.New(projectHost).
			Get("/auth/v1/health").
			Reply(http.StatusOK).
			JSON(tenant.HealthResponse{Version: "v2.74.2"})
		gock.New(projectHost).
			Get("/rest/v1/").
			Reply(http.StatusOK).
			JSON(tenant.SwaggerResponse{Info: tenant.SwaggerInfo{Version: "11.1.0"}})
		gock.New(projectHost).
			Get("/storage/v1/version").
			Reply(http.StatusOK).
			BodyString("1.28.0")
		// Run test
		images := listRemoteImages(context.Background(), flags.ProjectRef)
		// Check error
		assert.Equal(t, images, map[string]string{
			utils.Config.Db.Image:      "14.1.0.99",
			utils.Config.Auth.Image:    "v2.74.2",
			utils.Config.Api.Image:     "v11.1.0",
			utils.Config.Storage.Image: "v1.28.0",
		})
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}
