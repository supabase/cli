package check

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

func TestCheckSubdomain(t *testing.T) {
	t.Run("checks subdomain availability", func(t *testing.T) {
		t.Cleanup(fstest.MockStdout(t, "Subdomain example.com available: true\n"))
		t.Cleanup(apitest.MockPlatformAPI(t))
		// Setup mock api
		gock.New(utils.DefaultApiHost).
			Post("v1/projects/" + flags.ProjectRef + "/vanity-subdomain/check-availability").
			Reply(http.StatusCreated).
			JSON(api.SubdomainAvailabilityResponse{
				Available: true,
			})
		// Run test
		err := Run(context.Background(), flags.ProjectRef, "example.com", nil)
		assert.NoError(t, err)
	})

	t.Run("encodes toml output", func(t *testing.T) {
		utils.OutputFormat.Value = utils.OutputToml
		t.Cleanup(func() { utils.OutputFormat.Value = utils.OutputPretty })
		t.Cleanup(fstest.MockStdout(t, "Available = false\n"))
		t.Cleanup(apitest.MockPlatformAPI(t))
		// Setup mock api
		gock.New(utils.DefaultApiHost).
			Post("v1/projects/" + flags.ProjectRef + "/vanity-subdomain/check-availability").
			Reply(http.StatusCreated).
			JSON(api.SubdomainAvailabilityResponse{})
		// Run test
		err := Run(context.Background(), flags.ProjectRef, "example.com", nil)
		assert.NoError(t, err)
	})

	t.Run("throws error on network error", func(t *testing.T) {
		errNetwork := errors.New("network error")
		t.Cleanup(apitest.MockPlatformAPI(t))
		// Setup mock api
		gock.New(utils.DefaultApiHost).
			Post("/v1/projects/" + flags.ProjectRef + "/vanity-subdomain/check-availability").
			ReplyError(errNetwork)
		// Run test
		err := Run(context.Background(), flags.ProjectRef, "example.com", nil)
		assert.ErrorIs(t, err, errNetwork)
	})

	t.Run("throws error on service unavailable", func(t *testing.T) {
		utils.OutputFormat.Value = utils.OutputEnv
		t.Cleanup(func() { utils.OutputFormat.Value = utils.OutputPretty })
		t.Cleanup(apitest.MockPlatformAPI(t))
		// Setup mock api
		gock.New(utils.DefaultApiHost).
			Post("/v1/projects/" + flags.ProjectRef + "/vanity-subdomain/check-availability").
			Reply(http.StatusServiceUnavailable)
		// Run test
		err := Run(context.Background(), flags.ProjectRef, "example.com", nil)
		assert.ErrorContains(t, err, "unexpected check vanity subdomain status 503:")
	})
}
