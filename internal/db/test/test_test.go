package test

import (
	"bytes"
	"context"
	"errors"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/docker/docker/api/types"
	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/testing/apitest"
	"github.com/supabase/cli/internal/utils"
	"gopkg.in/h2non/gock.v1"
)

type MockFs struct {
	afero.MemMapFs
	DenyPath string
}

func (m *MockFs) Open(name string) (afero.File, error) {
	if strings.HasPrefix(name, m.DenyPath) {
		return nil, fs.ErrPermission
	}
	return m.MemMapFs.Open(name)
}

func TestTarDirectory(t *testing.T) {
	t.Run("tars a given directory", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		pgtap := "/tests/order_test.sql"
		require.NoError(t, afero.WriteFile(fsys, pgtap, []byte("SELECT 0;"), 0644))
		// Run test
		var buf bytes.Buffer
		assert.NoError(t, compress(filepath.Dir(pgtap), &buf, fsys))
	})

	t.Run("throws error on permission denied", func(t *testing.T) {
		// Setup in-memory fs
		pgtap := "/tests/order_test.sql"
		fsys := &MockFs{DenyPath: pgtap}
		require.NoError(t, afero.WriteFile(fsys, pgtap, []byte("SELECT 0;"), 0644))
		// Run test
		var buf bytes.Buffer
		err := compress(filepath.Dir(pgtap), &buf, fsys)
		// Check error
		assert.ErrorContains(t, err, "permission denied")
	})
}

func TestPgProve(t *testing.T) {
	t.Run("throws error on copy failure", func(t *testing.T) {
		utils.DbId = "test_db"
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, fsys.Mkdir(utils.DbTestsDir, 0755))
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		gock.New(utils.Docker.DaemonHost()).
			Put("/v" + utils.Docker.ClientVersion() + "/containers/test_db/archive").
			Reply(http.StatusServiceUnavailable)
		// Run test
		err := pgProve(context.Background(), "/tmp", fsys)
		// Check error
		assert.ErrorContains(t, err, "request returned Service Unavailable for API route and version")
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on exec failure", func(t *testing.T) {
		utils.DbId = "test_db"
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, fsys.Mkdir(utils.DbTestsDir, 0755))
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		gock.New(utils.Docker.DaemonHost()).
			Put("/v" + utils.Docker.ClientVersion() + "/containers/test_db/archive").
			Reply(http.StatusOK)
		gock.New(utils.Docker.DaemonHost()).
			Post("/v" + utils.Docker.ClientVersion() + "/containers/test_db/exec").
			ReplyError(errors.New("network error"))
		// Run test
		err := pgProve(context.Background(), "/tmp", fsys)
		// Check error
		assert.ErrorContains(t, err, "network error")
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}

func TestRunCommand(t *testing.T) {
	t.Run("throws error on missing config", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Run test
		err := Run(context.Background(), fsys)
		// Check error
		assert.ErrorIs(t, err, os.ErrNotExist)
	})

	t.Run("throws error on missing database", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, utils.WriteConfig(fsys, false))
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/containers/supabase_db_").
			ReplyError(errors.New("network error"))
		// Run test
		err := Run(context.Background(), fsys)
		// Check error
		assert.ErrorContains(t, err, "supabase start is not running.")
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on missing tests", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, utils.WriteConfig(fsys, false))
		// Setup mock docker
		require.NoError(t, apitest.MockDocker(utils.Docker))
		gock.New(utils.Docker.DaemonHost()).
			Get("/v" + utils.Docker.ClientVersion() + "/containers/supabase_db_").
			Reply(http.StatusOK).
			JSON(types.ContainerJSON{})
		// Run test
		err := Run(context.Background(), fsys)
		// Check error
		assert.ErrorContains(t, err, "open supabase/tests: file does not exist")
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}
