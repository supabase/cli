package create

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
	"github.com/supabase/cli/pkg/api"
)

func TestOrganizationCreateCommand(t *testing.T) {
	orgName := "Test Organization"

	t.Cleanup(func() {
		newConsole = utils.NewConsole
		utils.OutputFormat.Value = utils.OutputPretty
	})

	t.Run("create an organization", func(t *testing.T) {
		// Setup valid access token
		token := apitest.RandomAccessToken(t)
		t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))
		// Flush pending mocks after test execution
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Post("/v1/organizations").
			MatchType("json").
			JSON(createOrganizationRequest{Name: orgName}).
			Reply(http.StatusCreated).
			JSON(api.OrganizationResponseV1{
				Id:   "combined-fuchsia-lion",
				Name: orgName,
			})
		// Run test
		assert.NoError(t, Run(context.Background(), orgName))
		// Validate api
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("sends optional survey fields from interactive prompts", func(t *testing.T) {
		// Setup valid access token
		token := apitest.RandomAccessToken(t)
		t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))
		t.Cleanup(fstest.MockStdin(t, "GitHub\nAI coding assistant\n"))
		newConsole = func() *utils.Console {
			console := utils.NewConsole()
			console.IsTTY = true
			return console
		}
		t.Cleanup(func() {
			newConsole = utils.NewConsole
		})
		// Flush pending mocks after test execution
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Post("/v1/organizations").
			MatchType("json").
			JSON(createOrganizationRequest{
				Name:      orgName,
				HeardFrom: "GitHub",
				Building:  "AI coding assistant",
			}).
			Reply(http.StatusCreated).
			JSON(api.OrganizationResponseV1{
				Id:   "combined-fuchsia-lion",
				Name: orgName,
			})
		// Run test
		assert.NoError(t, Run(context.Background(), orgName))
		// Validate api
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("omits blank survey prompt answers", func(t *testing.T) {
		// Setup valid access token
		token := apitest.RandomAccessToken(t)
		t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))
		t.Cleanup(fstest.MockStdin(t, "\n\n"))
		newConsole = func() *utils.Console {
			console := utils.NewConsole()
			console.IsTTY = true
			return console
		}
		t.Cleanup(func() {
			newConsole = utils.NewConsole
		})
		// Flush pending mocks after test execution
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Post("/v1/organizations").
			MatchType("json").
			JSON(createOrganizationRequest{Name: orgName}).
			Reply(http.StatusCreated).
			JSON(api.OrganizationResponseV1{
				Id:   "combined-fuchsia-lion",
				Name: orgName,
			})
		// Run test
		assert.NoError(t, Run(context.Background(), orgName))
		// Validate api
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("skips survey prompts for structured output", func(t *testing.T) {
		// Setup valid access token
		token := apitest.RandomAccessToken(t)
		t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))
		utils.OutputFormat.Value = utils.OutputJson
		t.Cleanup(func() {
			utils.OutputFormat.Value = utils.OutputPretty
		})
		t.Cleanup(fstest.MockStdin(t, "GitHub\nAI coding assistant\n"))
		newConsole = func() *utils.Console {
			console := utils.NewConsole()
			console.IsTTY = true
			return console
		}
		t.Cleanup(func() {
			newConsole = utils.NewConsole
		})
		// Flush pending mocks after test execution
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Post("/v1/organizations").
			MatchType("json").
			JSON(createOrganizationRequest{Name: orgName}).
			Reply(http.StatusCreated).
			JSON(api.OrganizationResponseV1{
				Id:   "combined-fuchsia-lion",
				Name: orgName,
			})
		// Run test
		assert.NoError(t, Run(context.Background(), orgName))
		// Validate api
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on network error", func(t *testing.T) {
		// Setup valid access token
		token := apitest.RandomAccessToken(t)
		t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))
		// Flush pending mocks after test execution
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Post("/v1/organizations").
			MatchType("json").
			JSON(createOrganizationRequest{Name: orgName}).
			ReplyError(errors.New("network error"))
		// Run test
		assert.Error(t, Run(context.Background(), orgName))
		// Validate api
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on server unavailable", func(t *testing.T) {
		// Setup valid access token
		token := apitest.RandomAccessToken(t)
		t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))
		// Flush pending mocks after test execution
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Post("/v1/organizations").
			MatchType("json").
			JSON(createOrganizationRequest{Name: orgName}).
			Reply(http.StatusServiceUnavailable).
			JSON(map[string]string{"message": "unavailable"})
		// Run test
		assert.Error(t, Run(context.Background(), orgName))
		// Validate api
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}
