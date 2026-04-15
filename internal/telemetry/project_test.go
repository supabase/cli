package telemetry

import (
	"testing"
	"time"

	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/pkg/api"
)

var testProject = api.V1ProjectWithDatabaseResponse{
	Ref:              "proj_abc",
	Name:             "My Project",
	OrganizationId:   "org_123",
	OrganizationSlug: "acme",
}

func newTestService(t *testing.T, fsys afero.Fs, analytics *fakeAnalytics) *Service {
	t.Helper()
	service, err := NewService(fsys, Options{
		Analytics: analytics,
		Now:       func() time.Time { return time.Date(2026, time.April, 15, 12, 0, 0, 0, time.UTC) },
	})
	require.NoError(t, err)
	return service
}

func TestHasLinkedProject(t *testing.T) {
	t.Setenv("SUPABASE_HOME", "/tmp/supabase-home")

	t.Run("false when no cache", func(t *testing.T) {
		fsys := afero.NewMemMapFs()
		assert.False(t, HasLinkedProject(fsys))
	})

	t.Run("true when cache exists", func(t *testing.T) {
		fsys := afero.NewMemMapFs()
		require.NoError(t, SaveLinkedProject(testProject, fsys))
		assert.True(t, HasLinkedProject(fsys))
	})
}

func TestCacheProjectAndIdentifyGroups(t *testing.T) {
	t.Setenv("SUPABASE_HOME", "/tmp/supabase-home")

	t.Run("writes cache file", func(t *testing.T) {
		fsys := afero.NewMemMapFs()
		CacheProjectAndIdentifyGroups(testProject, nil, fsys)

		linked, err := LoadLinkedProject(fsys)
		require.NoError(t, err)
		assert.Equal(t, "proj_abc", linked.Ref)
		assert.Equal(t, "org_123", linked.OrganizationID)
		assert.Equal(t, "acme", linked.OrganizationSlug)
		assert.Equal(t, "My Project", linked.Name)
	})

	t.Run("fires GroupIdentify for org and project", func(t *testing.T) {
		fsys := afero.NewMemMapFs()
		analytics := &fakeAnalytics{enabled: true}
		service := newTestService(t, fsys, analytics)

		CacheProjectAndIdentifyGroups(testProject, service, fsys)

		require.Len(t, analytics.groupIdentifies, 2)

		orgCall := analytics.groupIdentifies[0]
		assert.Equal(t, GroupOrganization, orgCall.groupType)
		assert.Equal(t, "org_123", orgCall.groupKey)
		assert.Equal(t, "acme", orgCall.properties["organization_slug"])

		projCall := analytics.groupIdentifies[1]
		assert.Equal(t, GroupProject, projCall.groupType)
		assert.Equal(t, "proj_abc", projCall.groupKey)
		assert.Equal(t, "My Project", projCall.properties["name"])
		assert.Equal(t, "acme", projCall.properties["organization_slug"])
	})

	t.Run("skips GroupIdentify when service is nil", func(t *testing.T) {
		fsys := afero.NewMemMapFs()
		CacheProjectAndIdentifyGroups(testProject, nil, fsys)

		// Cache should still be written
		linked, err := LoadLinkedProject(fsys)
		require.NoError(t, err)
		assert.Equal(t, "proj_abc", linked.Ref)
	})

	t.Run("skips GroupIdentify for empty org ID", func(t *testing.T) {
		fsys := afero.NewMemMapFs()
		analytics := &fakeAnalytics{enabled: true}
		service := newTestService(t, fsys, analytics)

		noOrgProject := api.V1ProjectWithDatabaseResponse{
			Ref:  "proj_abc",
			Name: "My Project",
		}
		CacheProjectAndIdentifyGroups(noOrgProject, service, fsys)

		// Only project GroupIdentify, no org
		require.Len(t, analytics.groupIdentifies, 1)
		assert.Equal(t, GroupProject, analytics.groupIdentifies[0].groupType)
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
		require.NoError(t, SaveLinkedProject(testProject, fsys))
		groups := linkedProjectGroups(fsys)
		assert.Equal(t, map[string]string{
			GroupOrganization: "org_123",
			GroupProject:      "proj_abc",
		}, groups)
	})
}
