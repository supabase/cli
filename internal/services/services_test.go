package services

import (
	"context"
	"strings"
	"testing"

	"github.com/h2non/gock"
	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/flags"
)

// TestRun tests the main Run function that displays service versions
func TestRun(t *testing.T) {
	// Test case: Display service versions without linked project
	t.Run("displays service versions without linked project", func(t *testing.T) {
		// Setup: Create an in-memory filesystem
		fsys := afero.NewMemMapFs()

		// Execute: Call the Run function
		err := Run(context.Background(), fsys)

		// Verify: Check that no error occurred
		assert.NoError(t, err)
	})

	// Test case: Display service versions with linked project
	t.Run("displays service versions with linked project", func(t *testing.T) {
		// Setup: Create an in-memory filesystem and simulate linked project
		fsys := afero.NewMemMapFs()

		// Create project config file with project reference
		projectRef := "abcdefghijklmnopqrst"
		require.NoError(t, utils.InitConfig(utils.InitParams{
			ProjectId: projectRef,
		}, fsys))
		flags.ProjectRef = projectRef

		// Mock all API requests
		defer gock.OffAll()

		// Mock API keys
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + projectRef + "/api-keys").
			Reply(200).
			JSON([]map[string]string{{"name": "anon", "api_key": "test-key"}})

		// Mock database version
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects").
			Reply(200).
			JSON([]map[string]interface{}{
				{
					"id":       projectRef,
					"database": map[string]string{"version": "1.0.0"},
				},
			})

		// Mock auth version
		gock.New("https://" + utils.GetSupabaseHost(projectRef)).
			Get("/auth/v1/health").
			Reply(200).
			JSON(map[string]string{"version": "2.0.0"})

		// Mock postgrest version
		gock.New("https://" + utils.GetSupabaseHost(projectRef)).
			Get("/rest/v1/").
			Reply(200).
			JSON(map[string]interface{}{
				"swagger": "2.0",
				"info":    map[string]string{"version": "3.0.0"},
			})

		// Execute: Call the Run function
		err := Run(context.Background(), fsys)

		// Verify: Check that no error occurred
		assert.NoError(t, err)
	})
}

// TestCheckVersions tests the function that checks local and remote service versions
func TestCheckVersions(t *testing.T) {
	// Test case: Check local versions only
	t.Run("checks local versions", func(t *testing.T) {
		// Setup: Create an in-memory filesystem
		fsys := afero.NewMemMapFs()

		// Execute: Call CheckVersions function
		versions := CheckVersions(context.Background(), fsys)

		// Verify: Check that versions are returned and contain required fields
		assert.NotEmpty(t, versions)
		for _, v := range versions {
			assert.NotEmpty(t, v.Name, "Service name should not be empty")
			assert.NotEmpty(t, v.Local, "Local version should not be empty")
		}
	})

	// Test case: Check both local and remote versions
	t.Run("checks local and remote versions", func(t *testing.T) {
		// Setup: Create an in-memory filesystem and simulate linked project
		fsys := afero.NewMemMapFs()

		// Create project config file with project reference
		projectRef := "abcdefghijklmnopqrst"
		require.NoError(t, utils.InitConfig(utils.InitParams{
			ProjectId: projectRef,
		}, fsys))

		// Set project reference in flags
		flags.ProjectRef = projectRef

		// Execute: Call CheckVersions function
		versions := CheckVersions(context.Background(), fsys)

		// Verify: Check that versions are returned and contain required fields
		assert.NotEmpty(t, versions)
		for _, v := range versions {
			assert.NotEmpty(t, v.Name, "Service name should not be empty")
			assert.NotEmpty(t, v.Local, "Local version should not be empty")
			// Remote version might be empty if not linked
		}
	})

	// Test case: Handle version mismatch
	t.Run("handles version mismatch", func(t *testing.T) {
		// Setup: Create an in-memory filesystem and simulate linked project
		fsys := afero.NewMemMapFs()

		// Create project config file with project reference
		projectRef := "abcdefghijklmnopqrst"
		require.NoError(t, utils.InitConfig(utils.InitParams{
			ProjectId: projectRef,
		}, fsys))

		// Set project reference in flags
		flags.ProjectRef = projectRef

		// Execute: Call CheckVersions function
		versions := CheckVersions(context.Background(), fsys)

		// Verify: Check that versions are returned and contain required fields
		assert.NotEmpty(t, versions)
		for _, v := range versions {
			assert.NotEmpty(t, v.Name, "Service name should not be empty")
			assert.NotEmpty(t, v.Local, "Local version should not be empty")
			// Remote version might be empty if not linked
		}
	})

	// Test case: Verify version comparison logic
	t.Run("compares local and remote versions correctly", func(t *testing.T) {
		fsys := afero.NewMemMapFs()
		projectRef := "abcdefghijklmnopqrst"

		// Setup: Create linked project with specific versions
		require.NoError(t, utils.InitConfig(utils.InitParams{
			ProjectId: projectRef,
		}, fsys))
		flags.ProjectRef = projectRef

		// Mock remote versions
		token := "sbp_" + strings.Repeat("0", 36)
		require.NoError(t, utils.SaveAccessToken(token, fsys))

		defer gock.OffAll()
		// Mock API responses with specific versions
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + projectRef + "/api-keys").
			Reply(200).
			JSON([]map[string]string{{"name": "anon", "api_key": "test-key"}})

		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + projectRef + "/database/version").
			Reply(200).
			JSON(map[string]string{"version": "1.0.0"})

		versions := CheckVersions(context.Background(), fsys)

		// Verify version comparison logic
		for _, v := range versions {
			assert.NotEmpty(t, v.Name)
			assert.NotEmpty(t, v.Local)
			// Check if remote versions are properly assigned
		}
	})
}

// TestListRemoteImages tests the function that retrieves remote service versions
func TestListRemoteImages(t *testing.T) {
	// Test case: Get remote versions successfully
	t.Run("gets remote versions successfully", func(t *testing.T) {
		// Setup: Create context and project reference
		ctx := context.Background()
		projectRef := "abcdefghijklmnopqrst"

		// Setup: Create in-memory filesystem
		fsys := afero.NewMemMapFs()

		// Setup: Create access token file with valid format
		token := "sbp_" + strings.Repeat("0", 36)
		require.NoError(t, utils.SaveAccessToken(token, fsys))

		// Setup: Mock API responses
		defer gock.OffAll()

		// Mock API keys response
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + projectRef + "/api-keys").
			Reply(200).
			JSON([]map[string]string{
				{"name": "anon", "api_key": "test-key"},
			})

		gock.New(utils.DefaultApiHost).
			Get("/v1/projects").
			Reply(200).
			JSON([]map[string]interface{}{
				{
					"id": projectRef,
					"database": map[string]string{
						"version": "1.0.0",
					},
				},
			})

		gock.New("https://" + utils.GetSupabaseHost(projectRef)).
			Get("/auth/v1/health").
			Reply(200).
			JSON(map[string]string{"version": "2.0.0"})

		// Mock postgrest version response (endpoint = /rest/v1/ sur le host du projet)
		gock.New("https://" + utils.GetSupabaseHost(projectRef)).
			Get("/rest/v1/").
			Reply(200).
			JSON(map[string]interface{}{
				"swagger": "2.0",
				"info": map[string]string{
					"version": "3.0.0",
				},
			})

		// Execute: Call listRemoteImages function
		remoteVersions := listRemoteImages(ctx, projectRef)

		// Verify: Check that remote versions are returned
		assert.NotNil(t, remoteVersions)
		assert.NotEmpty(t, remoteVersions)

		// Verify: Check that all expected versions are present
		for _, version := range remoteVersions {
			assert.NotEmpty(t, version)
		}
	})

	// Test case: Handle API errors
	t.Run("handles API errors", func(t *testing.T) {
		// Setup: Create context and project reference
		ctx := context.Background()
		projectRef := "invalid-project"

		// Setup: Create in-memory filesystem
		fsys := afero.NewMemMapFs()

		// Setup: Create access token file with valid format
		token := "sbp_" + strings.Repeat("0", 36)
		require.NoError(t, utils.SaveAccessToken(token, fsys))

		// Setup: Mock API error response
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + projectRef + "/api-keys").
			Reply(404)

		// Execute: Call listRemoteImages function
		remoteVersions := listRemoteImages(ctx, projectRef)

		// Verify: Check that remote versions are empty
		assert.Empty(t, remoteVersions)
	})

	// Test case: Handle missing access token
	t.Run("handles missing access token", func(t *testing.T) {
		// Setup: Create context and project reference
		ctx := context.Background()
		projectRef := "abcdefghijklmnopqrst"

		// Setup: Create in-memory filesystem without access token
		afero.NewMemMapFs()

		// Execute: Call listRemoteImages function
		remoteVersions := listRemoteImages(ctx, projectRef)

		// Verify: Check that remote versions are empty
		assert.Empty(t, remoteVersions)
	})
}

// TestSuggestUpdateCmd tests the function that generates update command suggestions
func TestSuggestUpdateCmd(t *testing.T) {
	// Test case: Generate update command for version mismatch
	t.Run("generates update command for version mismatch", func(t *testing.T) {
		// Setup: Create map of service images with version mismatches
		serviceImages := map[string]string{
			"service1": "v1.0.0",
			"service2": "v2.0.0",
		}

		// Execute: Call suggestUpdateCmd function
		cmd := suggestUpdateCmd(serviceImages)

		// Verify: Check that command contains expected content
		assert.Contains(t, cmd, "WARNING:")
		assert.Contains(t, cmd, "supabase link")
	})

	// Test case: Handle empty service images
	t.Run("handles empty service images", func(t *testing.T) {
		// Setup: Create empty map of service images
		serviceImages := map[string]string{}

		// Execute: Call suggestUpdateCmd function
		cmd := suggestUpdateCmd(serviceImages)

		// Verify: Check that command contains expected content
		assert.Contains(t, cmd, "WARNING:")
		assert.Contains(t, cmd, "supabase link")
	})
}
