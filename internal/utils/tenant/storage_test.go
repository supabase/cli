package tenant

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/supabase/cli/internal/testing/apitest"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/api"
	"gopkg.in/h2non/gock.v1"
)

func TestStorageVersion(t *testing.T) {
	projectRef := apitest.RandomProjectRef()
	token := apitest.RandomAccessToken(t)
	t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))

	t.Run("appends prefix v", func(t *testing.T) {
		// Setup mock api
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + projectRef + "/api-keys").
			Reply(http.StatusOK).
			JSON([]api.ApiKeyResponse{{Name: "anon", ApiKey: "anon-key"}})
		gock.New(fmt.Sprintf("https://%s.supabase.co", projectRef)).
			Get("/storage/v1/version").
			Reply(http.StatusOK).
			BodyString("0.40.4")
		// Run test
		version, err := GetStorageVersion(context.Background(), projectRef)
		// Check error
		assert.NoError(t, err)
		assert.Equal(t, version, "v0.40.4")
	})

	t.Run("throws error on network error", func(t *testing.T) {
		// Setup mock api
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + projectRef + "/api-keys").
			Reply(http.StatusOK).
			JSON([]api.ApiKeyResponse{{Name: "anon", ApiKey: "anon-key"}})
		gock.New(fmt.Sprintf("https://%s.supabase.co", projectRef)).
			Get("/storage/v1/version").
			ReplyError(errors.New("network error"))
		// Run test
		version, err := GetStorageVersion(context.Background(), projectRef)
		// Check error
		assert.ErrorContains(t, err, "network error")
		assert.Empty(t, version)
	})

	t.Run("throws error on missing version", func(t *testing.T) {
		// Setup mock api
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + projectRef + "/api-keys").
			Reply(http.StatusOK).
			JSON([]api.ApiKeyResponse{{Name: "anon", ApiKey: "anon-key"}})
		gock.New(fmt.Sprintf("https://%s.supabase.co", projectRef)).
			Get("/storage/v1/version").
			Reply(http.StatusOK).
			BodyString("0.0.0")
		// Run test
		version, err := GetStorageVersion(context.Background(), projectRef)
		// Check error
		assert.ErrorIs(t, err, errStorageVersion)
		assert.Empty(t, version)
	})
}
