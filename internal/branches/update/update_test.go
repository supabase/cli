package update

import (
	"context"
	"errors"
	"net/http"
	"testing"

	"github.com/h2non/gock"
	"github.com/stretchr/testify/assert"
	"github.com/supabase/cli/internal/testing/apitest"
	"github.com/supabase/cli/internal/testing/fstest"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/flags"
	"github.com/supabase/cli/pkg/api"
)

func TestUpdateBranch(t *testing.T) {
	flags.ProjectRef = apitest.RandomProjectRef()

	t.Run("update branch attributes", func(t *testing.T) {
		t.Cleanup(fstest.MockStdout(t, `
  
   ID                 | NAME | DEFAULT | GIT BRANCH | WITH DATA | STATUS           | CREATED AT (UTC)    | UPDATED AT (UTC)    
  --------------------|------|---------|------------|-----------|------------------|---------------------|---------------------
   branch-project-ref | Dev  | false   |            | false     | CREATING_PROJECT | 0001-01-01 00:00:00 | 0001-01-01 00:00:00 

`))
		t.Cleanup(apitest.MockPlatformAPI(t))
		// Setup mock api
		gock.New(utils.DefaultApiHost).
			Patch("/v1/branches/" + flags.ProjectRef).
			Reply(http.StatusOK).
			JSON(api.BranchResponse{
				Name:       "Dev",
				ProjectRef: "branch-project-ref",
				Status:     api.BranchResponseStatusCREATINGPROJECT,
			})
		// Run test
		err := Run(context.Background(), flags.ProjectRef, api.UpdateBranchBody{}, nil)
		assert.NoError(t, err)
	})

	t.Run("encodes json format", func(t *testing.T) {
		utils.OutputFormat.Value = utils.OutputJson
		t.Cleanup(func() { utils.OutputFormat.Value = utils.OutputPretty })
		t.Cleanup(fstest.MockStdout(t, `{
  "created_at": "0001-01-01T00:00:00Z",
  "id": "00000000-0000-0000-0000-000000000000",
  "is_default": false,
  "name": "Dev",
  "parent_project_ref": "",
  "persistent": false,
  "project_ref": "branch-project-ref",
  "status": "CREATING_PROJECT",
  "updated_at": "0001-01-01T00:00:00Z",
  "with_data": false
}
`))
		t.Cleanup(apitest.MockPlatformAPI(t))
		// Setup mock api
		gock.New(utils.DefaultApiHost).
			Patch("/v1/branches/" + flags.ProjectRef).
			Reply(http.StatusOK).
			JSON(api.BranchResponse{
				Name:       "Dev",
				ProjectRef: "branch-project-ref",
				Status:     api.BranchResponseStatusCREATINGPROJECT,
			})
		// Run test
		err := Run(context.Background(), flags.ProjectRef, api.UpdateBranchBody{}, nil)
		assert.NoError(t, err)
	})

	t.Run("throws error on missing branch", func(t *testing.T) {
		errNetwork := errors.New("network error")
		t.Cleanup(apitest.MockPlatformAPI(t))
		// Setup mock api
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + flags.ProjectRef + "/branches/missing").
			ReplyError(errNetwork)
		// Run test
		err := Run(context.Background(), "missing", api.UpdateBranchBody{}, nil)
		assert.ErrorIs(t, err, errNetwork)
	})

	t.Run("throws error on network error", func(t *testing.T) {
		errNetwork := errors.New("network error")
		t.Cleanup(apitest.MockPlatformAPI(t))
		// Setup mock api
		gock.New(utils.DefaultApiHost).
			Patch("/v1/branches/" + flags.ProjectRef).
			ReplyError(errNetwork)
		// Run test
		err := Run(context.Background(), flags.ProjectRef, api.UpdateBranchBody{}, nil)
		assert.ErrorIs(t, err, errNetwork)
	})

	t.Run("throws error on service unavailable", func(t *testing.T) {
		t.Cleanup(apitest.MockPlatformAPI(t))
		// Setup mock api
		gock.New(utils.DefaultApiHost).
			Patch("/v1/branches/" + flags.ProjectRef).
			Reply(http.StatusServiceUnavailable)
		// Run test
		err := Run(context.Background(), flags.ProjectRef, api.UpdateBranchBody{}, nil)
		assert.ErrorContains(t, err, "unexpected update branch status 503:")
	})

	t.Run("suggests upgrade on payment required for persistent", func(t *testing.T) {
		t.Cleanup(apitest.MockPlatformAPI(t))
		t.Cleanup(func() { utils.CmdSuggestion = "" })
		// Mock branch update returns 402
		gock.New(utils.DefaultApiHost).
			Patch("/v1/branches/" + flags.ProjectRef).
			Reply(http.StatusPaymentRequired).
			JSON(map[string]interface{}{"message": "Persistent branches are not available on your plan"})
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
						"feature":   map[string]interface{}{"key": "branching_persistent", "type": "boolean"},
						"hasAccess": false,
						"type":      "boolean",
						"config":    map[string]interface{}{"enabled": false},
					},
				},
			})
		persistent := true
		err := Run(context.Background(), flags.ProjectRef, api.UpdateBranchBody{Persistent: &persistent}, nil)
		assert.ErrorContains(t, err, "unexpected update branch status 402")
		assert.Contains(t, utils.CmdSuggestion, "/org/test-org/billing")
	})
}
