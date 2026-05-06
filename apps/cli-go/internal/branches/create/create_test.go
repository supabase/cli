package create

import (
	"context"
	"net"
	"net/http"
	"testing"

	"github.com/google/uuid"
	"github.com/h2non/gock"
	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/testing/apitest"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/flags"
	"github.com/supabase/cli/pkg/api"
	"github.com/supabase/cli/pkg/cast"
)

func TestCreateCommand(t *testing.T) {
	// Setup valid project ref
	flags.ProjectRef = apitest.RandomProjectRef()

	t.Run("creates preview branch", func(t *testing.T) {
		// Setup valid access token
		token := apitest.RandomAccessToken(t)
		t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup mock api
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Post("/v1/projects/" + flags.ProjectRef + "/branches").
			Reply(http.StatusCreated).
			JSON(api.BranchResponse{
				Id: uuid.New(),
			})
		// Run test
		err := Run(context.Background(), api.CreateBranchBody{
			Region: cast.Ptr("sin"),
		}, fsys)
		// Check error
		assert.NoError(t, err)
	})

	t.Run("throws error on network disconnected", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, afero.WriteFile(fsys, utils.ProjectRefPath, []byte(flags.ProjectRef), 0644))
		// Setup mock api
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Post("/v1/projects/" + flags.ProjectRef + "/branches").
			ReplyError(net.ErrClosed)
		// Run test
		err := Run(context.Background(), api.CreateBranchBody{
			Region: cast.Ptr("sin"),
		}, fsys)
		// Check error
		assert.ErrorIs(t, err, net.ErrClosed)
	})

	t.Run("throws error on service unavailable", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, afero.WriteFile(fsys, utils.ProjectRefPath, []byte(flags.ProjectRef), 0644))
		// Setup mock api
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Post("/v1/projects/" + flags.ProjectRef + "/branches").
			Reply(http.StatusServiceUnavailable)
		// Run test
		err := Run(context.Background(), api.CreateBranchBody{
			Region: cast.Ptr("sin"),
		}, fsys)
		// Check error
		assert.ErrorContains(t, err, "unexpected create branch status 503:")
	})

	t.Run("suggests upgrade on payment required", func(t *testing.T) {
		t.Cleanup(apitest.MockPlatformAPI(t))
		t.Cleanup(func() { utils.CmdSuggestion = "" })
		// Mock branches create returns 402
		gock.New(utils.DefaultApiHost).
			Post("/v1/projects/" + flags.ProjectRef + "/branches").
			Reply(http.StatusPaymentRequired).
			JSON(map[string]interface{}{"message": "branching requires a paid plan"})
		// Mock project lookup for SuggestUpgradeOnError
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + flags.ProjectRef).
			Reply(http.StatusOK).
			JSON(map[string]interface{}{
				"ref":               flags.ProjectRef,
				"organization_slug": "test-org",
				"name":              "test",
				"region":            "us-east-1",
				"created_at":        "2024-01-01T00:00:00Z",
				"status":            "ACTIVE_HEALTHY",
				"database":          map[string]interface{}{"host": "db.example.supabase.co", "version": "15.1.0.117"},
			})
		// Mock entitlements
		gock.New(utils.DefaultApiHost).
			Get("/v1/organizations/test-org/entitlements").
			Reply(http.StatusOK).
			JSON(map[string]interface{}{
				"entitlements": []map[string]interface{}{
					{
						"feature":   map[string]interface{}{"key": "branching_limit", "type": "numeric"},
						"hasAccess": false,
						"type":      "numeric",
						"config":    map[string]interface{}{"enabled": false, "value": 0, "unlimited": false, "unit": "count"},
					},
				},
			})
		fsys := afero.NewMemMapFs()
		err := Run(context.Background(), api.CreateBranchBody{Region: cast.Ptr("sin")}, fsys)
		assert.ErrorContains(t, err, "unexpected create branch status 402")
		assert.Contains(t, utils.CmdSuggestion, "/org/test-org/billing")
	})
}
