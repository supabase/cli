package tenant

import (
	"context"
	"fmt"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/supabase/cli/internal/testing/apitest"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/api"
	"gopkg.in/h2non/gock.v1"
)

func TestPostgrestVersion(t *testing.T) {
	projectRef := apitest.RandomProjectRef()
	token := apitest.RandomAccessToken(t)
	t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))

	t.Run("appends prefix v", func(t *testing.T) {
		// Mock api
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + projectRef + "/api-keys").
			Reply(200).
			JSON([]api.ApiKeyResponse{{ApiKey: "anon-key"}})
		rest := SwaggerResponse{Info: SwaggerInfo{Version: "11.1.0"}}
		gock.New(fmt.Sprintf("https://%s.supabase.co", projectRef)).
			Get("/rest/v1/").
			Reply(200).
			JSON(rest)
		// Run test
		version, err := GetPostgrestVersion(context.Background(), projectRef)
		// Check error
		assert.NoError(t, err)
		assert.Equal(t, version, "v11.1.0")
	})

	t.Run("ignores commit hash", func(t *testing.T) {
		// Mock api
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + projectRef + "/api-keys").
			Reply(200).
			JSON([]api.ApiKeyResponse{{ApiKey: "anon-key"}})
		rest := SwaggerResponse{Info: SwaggerInfo{Version: "11.2.0 (c820efb)"}}
		gock.New(fmt.Sprintf("https://%s.supabase.co", projectRef)).
			Get("/rest/v1/").
			Reply(200).
			JSON(rest)
		// Run test
		version, err := GetPostgrestVersion(context.Background(), projectRef)
		// Check error
		assert.NoError(t, err)
		assert.Equal(t, version, "v11.2.0")
	})
}
