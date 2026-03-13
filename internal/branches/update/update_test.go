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
}
