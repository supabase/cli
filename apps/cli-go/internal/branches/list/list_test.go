package list

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/go-errors/errors"
	"github.com/h2non/gock"
	"github.com/stretchr/testify/assert"
	"github.com/supabase/cli/internal/testing/apitest"
	"github.com/supabase/cli/internal/testing/fstest"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/flags"
	"github.com/supabase/cli/pkg/api"
	"github.com/supabase/cli/pkg/cast"
)

func TestListBranches(t *testing.T) {
	flags.ProjectRef = apitest.RandomProjectRef()

	t.Run("lists all branches", func(t *testing.T) {
		t.Cleanup(fstest.MockStdout(t, `
  
   ID                  | NAME    | DEFAULT | GIT BRANCH | WITH DATA | STATUS           | CREATED AT (UTC)    | UPDATED AT (UTC)    
  ---------------------|---------|---------|------------|-----------|------------------|---------------------|---------------------
   staging-project-ref | Staging | false   | develop    | true      | CREATING_PROJECT | 2026-01-02 03:04:05 | 2026-01-03 03:04:05 

`))
		t.Cleanup(apitest.MockPlatformAPI(t))
		// Setup mock api
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + flags.ProjectRef + "/branches").
			Reply(http.StatusOK).
			JSON([]api.BranchResponse{{
				GitBranch:  cast.Ptr("develop"),
				ProjectRef: "staging-project-ref",
				Name:       "Staging",
				Persistent: true,
				WithData:   true,
				Status:     api.BranchResponseStatusCREATINGPROJECT,
				CreatedAt:  time.Date(2026, 01, 02, 03, 04, 05, 0, time.UTC),
				UpdatedAt:  time.Date(2026, 01, 03, 03, 04, 05, 0, time.UTC),
			}})
		// Run test
		err := Run(context.Background(), nil)
		assert.NoError(t, err)
	})

	t.Run("encodes toml format", func(t *testing.T) {
		utils.OutputFormat.Value = utils.OutputToml
		t.Cleanup(func() { utils.OutputFormat.Value = utils.OutputPretty })
		t.Cleanup(fstest.MockStdout(t, `[[branches]]
  CreatedAt = 0001-01-01T00:00:00Z
  Id = "00000000-0000-0000-0000-000000000000"
  IsDefault = true
  Name = "Production"
  ParentProjectRef = "production-project-ref"
  Persistent = false
  ProjectRef = "production-project-ref"
  Status = "FUNCTIONS_DEPLOYED"
  UpdatedAt = 0001-01-01T00:00:00Z
  WithData = false
`))
		t.Cleanup(apitest.MockPlatformAPI(t))
		// Setup mock api
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + flags.ProjectRef + "/branches").
			Reply(http.StatusOK).
			JSON([]api.BranchResponse{{
				Name:             "Production",
				IsDefault:        true,
				ParentProjectRef: "production-project-ref",
				ProjectRef:       "production-project-ref",
				Status:           api.BranchResponseStatusFUNCTIONSDEPLOYED,
			}})
		// Run test
		err := Run(context.Background(), nil)
		assert.NoError(t, err)
	})

	t.Run("throws error on network error", func(t *testing.T) {
		errNetwork := errors.New("network error")
		t.Cleanup(apitest.MockPlatformAPI(t))
		// Setup mock api
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + flags.ProjectRef + "/branches").
			ReplyError(errNetwork)
		// Run test
		err := Run(context.Background(), nil)
		assert.ErrorIs(t, err, errNetwork)
	})

	t.Run("throws error on env format", func(t *testing.T) {
		utils.OutputFormat.Value = utils.OutputEnv
		t.Cleanup(func() { utils.OutputFormat.Value = utils.OutputPretty })
		t.Cleanup(apitest.MockPlatformAPI(t))
		// Setup mock api
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + flags.ProjectRef + "/branches").
			Reply(http.StatusOK).
			JSON([]api.BranchResponse{})
		// Run test
		err := Run(context.Background(), nil)
		assert.ErrorIs(t, err, utils.ErrEnvNotSupported)
	})
}

func TestFilterBranch(t *testing.T) {
	flags.ProjectRef = apitest.RandomProjectRef()

	t.Run("filter branch by name", func(t *testing.T) {
		t.Cleanup(apitest.MockPlatformAPI(t))
		// Setup mock api
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + flags.ProjectRef + "/branches").
			Reply(http.StatusOK).
			JSON([]api.BranchResponse{{
				Name:      "Production",
				IsDefault: true,
			}, {
				Name:       "Staging",
				Persistent: true,
			}})
		// Run test
		result, err := ListBranch(context.Background(), flags.ProjectRef, FilterByName("Production"))
		assert.NoError(t, err)
		assert.Len(t, result, 1)
		assert.True(t, result[0].IsDefault)
	})

	t.Run("throws error on service unavailable", func(t *testing.T) {
		t.Cleanup(apitest.MockPlatformAPI(t))
		// Setup mock api
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + flags.ProjectRef + "/branches").
			Reply(http.StatusServiceUnavailable)
		// Run test
		_, err := ListBranch(context.Background(), flags.ProjectRef, FilterByName("Production"))
		assert.ErrorContains(t, err, "unexpected list branch status 503:")
	})
}
