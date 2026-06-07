package download

import (
	"context"
	"net/http"
	"testing"

	"github.com/go-errors/errors"
	"github.com/google/uuid"
	"github.com/h2non/gock"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/testing/apitest"
	"github.com/supabase/cli/internal/testing/fstest"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/flags"
	"github.com/supabase/cli/pkg/api"
)

func TestSnippetDownload(t *testing.T) {
	flags.ProjectRef = apitest.RandomProjectRef()
	snippetId, err := uuid.NewUUID()
	require.NoError(t, err)

	t.Run("downloads sql snippet", func(t *testing.T) {
		t.Cleanup(fstest.MockStdout(t, "select 1\n"))
		t.Cleanup(apitest.MockPlatformAPI(t))
		// Setup mock api
		gock.New(utils.DefaultApiHost).
			Get("v1/snippets/" + snippetId.String()).
			Reply(http.StatusOK).
			JSON(api.SnippetResponse{Content: struct {
				Favorite      *bool  `json:"favorite,omitempty"`
				SchemaVersion string `json:"schema_version"`
				Sql           string `json:"sql"`
			}{
				Sql: "select 1",
			}})
		// Run test
		err = Run(context.Background(), snippetId.String(), nil)
		assert.NoError(t, err)
	})

	t.Run("throws error on invalid id", func(t *testing.T) {
		err := Run(context.Background(), "", nil)
		assert.ErrorContains(t, err, "invalid snippet ID:")
	})

	t.Run("throws error on network error", func(t *testing.T) {
		errNetwork := errors.New("network error")
		t.Cleanup(apitest.MockPlatformAPI(t))
		// Setup mock api
		gock.New(utils.DefaultApiHost).
			Get("v1/snippets/" + snippetId.String()).
			ReplyError(errNetwork)
		// Run test
		err := Run(context.Background(), snippetId.String(), nil)
		assert.ErrorIs(t, err, errNetwork)
	})

	t.Run("throws error on service unavailable", func(t *testing.T) {
		utils.OutputFormat.Value = utils.OutputEnv
		t.Cleanup(func() { utils.OutputFormat.Value = utils.OutputPretty })
		t.Cleanup(apitest.MockPlatformAPI(t))
		// Setup mock api
		gock.New(utils.DefaultApiHost).
			Get("v1/snippets/" + snippetId.String()).
			Reply(http.StatusServiceUnavailable)
		// Run test
		err := Run(context.Background(), snippetId.String(), nil)
		assert.ErrorContains(t, err, "unexpected download snippet status 503:")
	})
}
