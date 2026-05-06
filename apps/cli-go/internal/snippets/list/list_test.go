package list

import (
	"context"
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
)

func TestListSnippets(t *testing.T) {
	flags.ProjectRef = apitest.RandomProjectRef()

	t.Run("lists sql snippets", func(t *testing.T) {
		t.Cleanup(fstest.MockStdout(t, `
  
   ID           | NAME         | VISIBILITY | OWNER    | CREATED AT (UTC)    | UPDATED AT (UTC)    
  --------------|--------------|------------|----------|---------------------|---------------------
   test-snippet | Create table | user       | supaseed | 2023-10-13 17:48:58 | 2023-10-13 17:48:58 

`))
		t.Cleanup(apitest.MockPlatformAPI(t))
		// Setup mock api
		gock.New(utils.DefaultApiHost).
			Get("v1/snippets").
			Reply(http.StatusOK).
			JSON(api.SnippetList{Data: []struct {
				Description nullable.Nullable[string] `json:"description"`
				Favorite    bool                      `json:"favorite"`
				Id          string                    `json:"id"`
				InsertedAt  string                    `json:"inserted_at"`
				Name        string                    `json:"name"`
				Owner       struct {
					Id       float32 `json:"id"`
					Username string  `json:"username"`
				} `json:"owner"`
				Project struct {
					Id   float32 `json:"id"`
					Name string  `json:"name"`
				} `json:"project"`
				Type      api.SnippetListDataType `json:"type"`
				UpdatedAt string                  `json:"updated_at"`
				UpdatedBy struct {
					Id       float32 `json:"id"`
					Username string  `json:"username"`
				} `json:"updated_by"`
				Visibility api.SnippetListDataVisibility `json:"visibility"`
			}{{
				Id:         "test-snippet",
				Name:       "Create table",
				Visibility: api.SnippetListDataVisibilityUser,
				Owner: struct {
					Id       float32 `json:"id"`
					Username string  `json:"username"`
				}{
					Username: "supaseed",
				},
				InsertedAt: "2023-10-13T17:48:58.491Z",
				UpdatedAt:  "2023-10-13T17:48:58.491Z",
			}}})
		// Run test
		err := Run(context.Background(), nil)
		assert.NoError(t, err)
	})

	t.Run("encodes json output", func(t *testing.T) {
		utils.OutputFormat.Value = utils.OutputJson
		t.Cleanup(func() { utils.OutputFormat.Value = utils.OutputPretty })
		t.Cleanup(fstest.MockStdout(t, `{
  "data": null
}
`))
		t.Cleanup(apitest.MockPlatformAPI(t))
		// Setup mock api
		gock.New(utils.DefaultApiHost).
			Get("v1/snippets").
			Reply(http.StatusOK).
			JSON(api.SnippetList{})
		// Run test
		err := Run(context.Background(), nil)
		assert.NoError(t, err)
	})

	t.Run("throws error on env format", func(t *testing.T) {
		utils.OutputFormat.Value = utils.OutputEnv
		t.Cleanup(func() { utils.OutputFormat.Value = utils.OutputPretty })
		t.Cleanup(apitest.MockPlatformAPI(t))
		// Setup mock api
		gock.New(utils.DefaultApiHost).
			Get("v1/snippets").
			Reply(http.StatusOK).
			JSON(api.SnippetList{})
		// Run test
		err := Run(context.Background(), nil)
		assert.ErrorIs(t, err, utils.ErrEnvNotSupported)
	})

	t.Run("throws error on network error", func(t *testing.T) {
		errNetwork := errors.New("network error")
		t.Cleanup(apitest.MockPlatformAPI(t))
		// Setup mock api
		gock.New(utils.DefaultApiHost).
			Get("v1/snippets").
			ReplyError(errNetwork)
		// Run test
		err := Run(context.Background(), nil)
		assert.ErrorIs(t, err, errNetwork)
	})

	t.Run("throws error on service unavailable", func(t *testing.T) {
		utils.OutputFormat.Value = utils.OutputEnv
		t.Cleanup(func() { utils.OutputFormat.Value = utils.OutputPretty })
		t.Cleanup(apitest.MockPlatformAPI(t))
		// Setup mock api
		gock.New(utils.DefaultApiHost).
			Get("v1/snippets").
			Reply(http.StatusServiceUnavailable)
		// Run test
		err := Run(context.Background(), nil)
		assert.ErrorContains(t, err, "unexpected list snippets status 503:")
	})
}
