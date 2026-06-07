package reverify

import (
	"context"
	"net/http"
	"testing"

	"github.com/go-errors/errors"
	"github.com/h2non/gock"
	"github.com/stretchr/testify/assert"
	"github.com/supabase/cli/internal/testing/apitest"
	"github.com/supabase/cli/internal/testing/fstest"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/flags"
	"github.com/supabase/cli/pkg/api"
)

func TestReverifyHostname(t *testing.T) {
	flags.ProjectRef = apitest.RandomProjectRef()

	t.Run("reverify custom hostname", func(t *testing.T) {
		t.Cleanup(apitest.MockPlatformAPI(t))
		// Setup mock api
		gock.New(utils.DefaultApiHost).
			Post("v1/projects/" + flags.ProjectRef + "/custom-hostname/reverify").
			Reply(http.StatusCreated).
			JSON(api.UpdateCustomHostnameResponse{})
		// Run test
		err := Run(context.Background(), flags.ProjectRef, nil)
		assert.NoError(t, err)
	})

	t.Run("encodes toml output", func(t *testing.T) {
		utils.OutputFormat.Value = utils.OutputToml
		t.Cleanup(func() { utils.OutputFormat.Value = utils.OutputPretty })
		t.Cleanup(fstest.MockStdout(t, `CustomHostname = ""
Status = "2_initiated"

[Data]
  Success = false
  [Data.Result]
    CustomOriginServer = ""
    Hostname = ""
    Id = ""
    Status = ""
    [Data.Result.OwnershipVerification]
      Name = ""
      Type = ""
      Value = ""
    [Data.Result.Ssl]
      Status = ""
`))
		t.Cleanup(apitest.MockPlatformAPI(t))
		// Setup mock api
		gock.New(utils.DefaultApiHost).
			Post("v1/projects/" + flags.ProjectRef + "/custom-hostname/reverify").
			Reply(http.StatusCreated).
			JSON(api.UpdateCustomHostnameResponse{
				Status: api.N2Initiated,
			})
		// Run test
		err := Run(context.Background(), flags.ProjectRef, nil)
		assert.NoError(t, err)
	})

	t.Run("throws error on network error", func(t *testing.T) {
		errNetwork := errors.New("network error")
		t.Cleanup(apitest.MockPlatformAPI(t))
		// Setup mock api
		gock.New(utils.DefaultApiHost).
			Post("v1/projects/" + flags.ProjectRef + "/custom-hostname/reverify").
			ReplyError(errNetwork)
		// Run test
		err := Run(context.Background(), flags.ProjectRef, nil)
		assert.ErrorIs(t, err, errNetwork)
	})

	t.Run("throws error on service unavailable", func(t *testing.T) {
		utils.OutputFormat.Value = utils.OutputEnv
		t.Cleanup(func() { utils.OutputFormat.Value = utils.OutputPretty })
		t.Cleanup(apitest.MockPlatformAPI(t))
		// Setup mock api
		gock.New(utils.DefaultApiHost).
			Post("v1/projects/" + flags.ProjectRef + "/custom-hostname/reverify").
			Reply(http.StatusServiceUnavailable)
		// Run test
		err := Run(context.Background(), flags.ProjectRef, nil)
		assert.ErrorContains(t, err, "unexpected re-verify hostname status 503:")
	})
}
