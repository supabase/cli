package telemetry

import (
	"context"
	"net/http"
	"testing"

	"github.com/h2non/gock"
	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/testing/apitest"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/api"
)

func TestEnsureProjectGroupsCached(t *testing.T) {
	t.Setenv("SUPABASE_HOME", "/tmp/supabase-home")

	projectJSON := map[string]interface{}{
		"ref":               "proj_abc",
		"organization_id":   "org_123",
		"organization_slug": "acme",
		"name":              "My Project",
		"region":            "us-east-1",
		"created_at":        "2024-01-01T00:00:00Z",
		"status":            "ACTIVE_HEALTHY",
		"database":          map[string]interface{}{"host": "db.example.supabase.co", "version": "15.1.0.117"},
	}

	t.Run("skips when project ref is empty", func(t *testing.T) {
		fsys := afero.NewMemMapFs()
		EnsureProjectGroupsCached(context.Background(), "", fsys)
		_, err := LoadLinkedProject(fsys)
		assert.Error(t, err)
	})

	t.Run("skips when cache already matches", func(t *testing.T) {
		fsys := afero.NewMemMapFs()
		require.NoError(t, SaveLinkedProject(api.V1ProjectWithDatabaseResponse{
			Ref:              "proj_abc",
			Name:             "My Project",
			OrganizationId:   "org_123",
			OrganizationSlug: "acme",
		}, fsys))
		// No gock mocks — any API call would panic
		EnsureProjectGroupsCached(context.Background(), "proj_abc", fsys)
		linked, err := LoadLinkedProject(fsys)
		require.NoError(t, err)
		assert.Equal(t, "org_123", linked.OrganizationID)
	})

	t.Run("fetches and caches when no cache exists", func(t *testing.T) {
		t.Cleanup(apitest.MockPlatformAPI(t))
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/proj_abc").
			Reply(http.StatusOK).
			JSON(projectJSON)

		fsys := afero.NewMemMapFs()
		EnsureProjectGroupsCached(context.Background(), "proj_abc", fsys)

		linked, err := LoadLinkedProject(fsys)
		require.NoError(t, err)
		assert.Equal(t, "proj_abc", linked.Ref)
		assert.Equal(t, "org_123", linked.OrganizationID)
		assert.Equal(t, "acme", linked.OrganizationSlug)
	})

	t.Run("updates cache when ref differs", func(t *testing.T) {
		t.Cleanup(apitest.MockPlatformAPI(t))
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/proj_xyz").
			Reply(http.StatusOK).
			JSON(map[string]interface{}{
				"ref":               "proj_xyz",
				"organization_id":   "org_456",
				"organization_slug": "other",
				"name":              "Other Project",
				"region":            "eu-west-1",
				"created_at":        "2024-06-01T00:00:00Z",
				"status":            "ACTIVE_HEALTHY",
				"database":          map[string]interface{}{"host": "db.other.supabase.co", "version": "15.1.0.117"},
			})

		fsys := afero.NewMemMapFs()
		require.NoError(t, SaveLinkedProject(api.V1ProjectWithDatabaseResponse{
			Ref:              "proj_abc",
			Name:             "My Project",
			OrganizationId:   "org_123",
			OrganizationSlug: "acme",
		}, fsys))

		EnsureProjectGroupsCached(context.Background(), "proj_xyz", fsys)

		linked, err := LoadLinkedProject(fsys)
		require.NoError(t, err)
		assert.Equal(t, "proj_xyz", linked.Ref)
		assert.Equal(t, "org_456", linked.OrganizationID)
	})

	t.Run("no-ops on API error", func(t *testing.T) {
		t.Cleanup(apitest.MockPlatformAPI(t))
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/proj_bad").
			ReplyError(assert.AnError)

		fsys := afero.NewMemMapFs()
		EnsureProjectGroupsCached(context.Background(), "proj_bad", fsys)

		_, err := LoadLinkedProject(fsys)
		assert.Error(t, err) // no cache written
	})

	t.Run("no-ops on 404", func(t *testing.T) {
		t.Cleanup(apitest.MockPlatformAPI(t))
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/proj_missing").
			Reply(http.StatusNotFound)

		fsys := afero.NewMemMapFs()
		EnsureProjectGroupsCached(context.Background(), "proj_missing", fsys)

		_, err := LoadLinkedProject(fsys)
		assert.Error(t, err) // no cache written
	})
}

func TestLinkedProjectGroups(t *testing.T) {
	t.Setenv("SUPABASE_HOME", "/tmp/supabase-home")

	t.Run("returns nil when no cache", func(t *testing.T) {
		fsys := afero.NewMemMapFs()
		groups := linkedProjectGroups(fsys)
		assert.Nil(t, groups)
	})

	t.Run("returns groups from cache", func(t *testing.T) {
		fsys := afero.NewMemMapFs()
		require.NoError(t, SaveLinkedProject(api.V1ProjectWithDatabaseResponse{
			Ref:              "proj_abc",
			Name:             "My Project",
			OrganizationId:   "org_123",
			OrganizationSlug: "acme",
		}, fsys))
		groups := linkedProjectGroups(fsys)
		assert.Equal(t, map[string]string{
			GroupOrganization: "org_123",
			GroupProject:      "proj_abc",
		}, groups)
	})
}
