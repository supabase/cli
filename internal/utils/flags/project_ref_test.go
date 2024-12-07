package flags

import (
	"context"
	"net/http"
	"os"
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/go-errors/errors"
	"github.com/h2non/gock"
	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/testing/apitest"
	"github.com/supabase/cli/internal/testing/fstest"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/api"
)

func TestProjectRef(t *testing.T) {
	t.Run("validates cmd flag", func(t *testing.T) {
		ProjectRef = "invalid"
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Run test
		err := ParseProjectRef(context.Background(), fsys)
		// Check error
		assert.Error(t, err, utils.ErrInvalidRef)
	})

	t.Run("loads from linked", func(t *testing.T) {
		ProjectRef = ""
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup valid project ref
		project := apitest.RandomProjectRef()
		err := afero.WriteFile(fsys, utils.ProjectRefPath, []byte(project), 0644)
		require.NoError(t, err)
		// Run test
		err = ParseProjectRef(context.Background(), fsys)
		// Check error
		assert.NoError(t, err)
	})

	t.Run("throws error on read failure", func(t *testing.T) {
		ProjectRef = ""
		// Setup in-memory fs
		fsys := &fstest.OpenErrorFs{DenyPath: utils.ProjectRefPath}
		// Run test
		err := ParseProjectRef(context.Background(), fsys)
		// Check error
		assert.ErrorIs(t, err, os.ErrPermission)
	})

	t.Run("throws error if all fail", func(t *testing.T) {
		ProjectRef = ""
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Run test
		err := ParseProjectRef(context.Background(), fsys)
		// Check error
		assert.ErrorIs(t, err, utils.ErrNotLinked)
	})
}

func TestProjectPrompt(t *testing.T) {
	// Setup valid access token
	token := apitest.RandomAccessToken(t)
	t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))

	t.Run("validates prompt input", func(t *testing.T) {
		input := tea.WithInput(strings.NewReader("\r"))
		// Setup mock api
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects").
			Reply(http.StatusOK).
			JSON([]api.V1ProjectResponse{{
				Id:             "test-project",
				Name:           "My Project",
				OrganizationId: "test-org",
			}})
		// Run test
		err := PromptProjectRef(context.Background(), "", input)
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on network failure", func(t *testing.T) {
		errNetwork := errors.New("network error")
		// Setup mock api
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects").
			ReplyError(errNetwork)
		// Run test
		err := PromptProjectRef(context.Background(), "")
		// Check error
		assert.ErrorIs(t, err, errNetwork)
	})

	t.Run("throws error on service unavailable", func(t *testing.T) {
		// Setup mock api
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects").
			Reply(http.StatusServiceUnavailable)
		// Run test
		err := PromptProjectRef(context.Background(), "")
		// Check error
		assert.ErrorContains(t, err, "Unexpected error retrieving projects:")
	})
}
