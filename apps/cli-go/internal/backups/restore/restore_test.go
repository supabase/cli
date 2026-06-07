package restore

import (
	"context"
	"net/http"
	"testing"

	"github.com/go-errors/errors"
	"github.com/h2non/gock"
	"github.com/stretchr/testify/assert"
	"github.com/supabase/cli/internal/testing/apitest"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/flags"
)

func TestRestoreBackup(t *testing.T) {
	// Setup valid project ref
	flags.ProjectRef = apitest.RandomProjectRef()

	t.Run("restores project to timestamp", func(t *testing.T) {
		t.Cleanup(apitest.MockPlatformAPI(t))
		// Setup mock api
		gock.New(utils.DefaultApiHost).
			Post("/v1/projects/" + flags.ProjectRef + "/database/backups/restore-pitr").
			Reply(http.StatusCreated)
		// Run test
		err := Run(context.Background(), 0)
		assert.NoError(t, err)
	})

	t.Run("throws error on network error", func(t *testing.T) {
		errNetwork := errors.New("network error")
		t.Cleanup(apitest.MockPlatformAPI(t))
		// Setup mock api
		gock.New(utils.DefaultApiHost).
			Post("/v1/projects/" + flags.ProjectRef + "/database/backups/restore-pitr").
			ReplyError(errNetwork)
		// Run test
		err := Run(context.Background(), 0)
		assert.ErrorIs(t, err, errNetwork)
	})

	t.Run("throws error on service unavailable", func(t *testing.T) {
		t.Cleanup(apitest.MockPlatformAPI(t))
		// Setup mock api
		gock.New(utils.DefaultApiHost).
			Post("/v1/projects/" + flags.ProjectRef + "/database/backups/restore-pitr").
			Reply(http.StatusServiceUnavailable)
		// Run test
		err := Run(context.Background(), 0)
		assert.ErrorContains(t, err, "unexpected restore backup status 503:")
	})
}
