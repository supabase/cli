package list

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

func TestListBackup(t *testing.T) {
	// Setup valid access token
	token := apitest.RandomAccessToken(t)
	t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))
	// Setup valid project ref
	flags.ProjectRef = apitest.RandomProjectRef()

	t.Run("lists PITR backup", func(t *testing.T) {
		t.Cleanup(fstest.MockStdout(t, `
  
   REGION                     | WALG | PITR | EARLIEST TIMESTAMP | LATEST TIMESTAMP 
  ----------------------------|------|------|--------------------|------------------
   Southeast Asia (Singapore) | true | true | 0                  | 0                

`))
		// Setup mock api
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + flags.ProjectRef + "/database/backups").
			Reply(http.StatusOK).
			JSON(api.V1BackupsResponse{
				Region:      "ap-southeast-1",
				WalgEnabled: true,
				PitrEnabled: true,
			})
		// Run test
		err := Run(context.Background())
		assert.NoError(t, err)
	})

	t.Run("lists WALG backup", func(t *testing.T) {
		t.Cleanup(fstest.MockStdout(t, `
  
   REGION                     | BACKUP TYPE | STATUS    | CREATED AT (UTC)    
  ----------------------------|-------------|-----------|---------------------
   Southeast Asia (Singapore) | PHYSICAL    | COMPLETED | 2026-02-08 16:44:07 

`))
		// Setup mock api
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + flags.ProjectRef + "/database/backups").
			Reply(http.StatusOK).
			JSON(api.V1BackupsResponse{
				Region: "ap-southeast-1",
				Backups: []struct {
					InsertedAt       string                             `json:"inserted_at"`
					IsPhysicalBackup bool                               `json:"is_physical_backup"`
					Status           api.V1BackupsResponseBackupsStatus `json:"status"`
				}{{
					InsertedAt:       "2026-02-08 16:44:07",
					IsPhysicalBackup: true,
					Status:           api.V1BackupsResponseBackupsStatusCOMPLETED,
				}},
			})
		// Run test
		err := Run(context.Background())
		assert.NoError(t, err)
	})

	t.Run("throws error on network error", func(t *testing.T) {
		errNetwork := errors.New("network error")
		// Setup mock api
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + flags.ProjectRef + "/database/backups").
			ReplyError(errNetwork)
		// Run test
		err := Run(context.Background())
		assert.ErrorIs(t, err, errNetwork)
	})

	t.Run("throws error on service unavailable", func(t *testing.T) {
		// Setup mock api
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + flags.ProjectRef + "/database/backups").
			Reply(http.StatusServiceUnavailable)
		// Run test
		err := Run(context.Background())
		assert.ErrorContains(t, err, "unexpected list backup status 503:")
	})
}
