package stop

import (
	"context"
	"io"
	"testing"

	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/config"
)

func TestRun(t *testing.T) {
	t.Run("calls stop apple analytics forwarders on apple runtime", func(t *testing.T) {
		// Save original state
		originalRuntime := utils.Config.Runtime.Backend
		originalStopForwarders := stopAppleAnalyticsForwarders
		originalRemoveAll := dockerRemoveAll
		originalListVolumes := listProjectVolumes
		var forwarderCalled bool

		// Setup cleanup
		t.Cleanup(func() {
			utils.Config.Runtime.Backend = originalRuntime
			stopAppleAnalyticsForwarders = originalStopForwarders
			dockerRemoveAll = originalRemoveAll
			listProjectVolumes = originalListVolumes
		})

		// Set Apple container runtime
		utils.Config.Runtime.Backend = config.AppleContainerRuntime
		utils.Config.ProjectId = "test-project"

		// Mock the dependencies
		stopAppleAnalyticsForwarders = func(fsys afero.Fs) error {
			forwarderCalled = true
			return nil
		}
		dockerRemoveAll = func(ctx context.Context, w io.Writer, projectId string) error {
			return nil
		}
		listProjectVolumes = func(ctx context.Context, projectId string) ([]utils.VolumeInfo, error) {
			return nil, nil // No volumes to show suggestion
		}

		// Run test
		err := Run(context.Background(), false, "test-project", false, afero.NewMemMapFs())

		// Assert
		require.NoError(t, err)
		assert.True(t, forwarderCalled, "StopAppleAnalyticsForwarders should be called on Apple runtime")
	})

	t.Run("does not call stop apple analytics forwarders on docker runtime", func(t *testing.T) {
		// Save original state
		originalRuntime := utils.Config.Runtime.Backend
		originalStopForwarders := stopAppleAnalyticsForwarders
		originalRemoveAll := dockerRemoveAll
		originalListVolumes := listProjectVolumes
		var forwarderCalled bool

		// Setup cleanup
		t.Cleanup(func() {
			utils.Config.Runtime.Backend = originalRuntime
			stopAppleAnalyticsForwarders = originalStopForwarders
			dockerRemoveAll = originalRemoveAll
			listProjectVolumes = originalListVolumes
		})

		// Set Docker runtime (default)
		utils.Config.Runtime.Backend = config.DockerRuntime
		utils.Config.ProjectId = "test-project"

		// Mock the dependencies
		stopAppleAnalyticsForwarders = func(fsys afero.Fs) error {
			forwarderCalled = true
			return nil
		}
		dockerRemoveAll = func(ctx context.Context, w io.Writer, projectId string) error {
			return nil
		}
		listProjectVolumes = func(ctx context.Context, projectId string) ([]utils.VolumeInfo, error) {
			return nil, nil
		}

		// Run test
		err := Run(context.Background(), false, "test-project", false, afero.NewMemMapFs())

		// Assert
		require.NoError(t, err)
		assert.False(t, forwarderCalled, "StopAppleAnalyticsForwarders should not be called on Docker runtime")
	})

	t.Run("shows apple volume suggestion with project id on apple runtime", func(t *testing.T) {
		// Save original state
		originalRuntime := utils.Config.Runtime.Backend
		originalStopForwarders := stopAppleAnalyticsForwarders
		originalRemoveAll := dockerRemoveAll
		originalListVolumes := listProjectVolumes

		// Setup cleanup
		t.Cleanup(func() {
			utils.Config.Runtime.Backend = originalRuntime
			stopAppleAnalyticsForwarders = originalStopForwarders
			dockerRemoveAll = originalRemoveAll
			listProjectVolumes = originalListVolumes
			utils.CmdSuggestion = ""
		})

		// Set Apple container runtime
		utils.Config.Runtime.Backend = config.AppleContainerRuntime
		utils.Config.ProjectId = "test-project"

		// Mock the dependencies
		stopAppleAnalyticsForwarders = func(fsys afero.Fs) error {
			return nil
		}
		dockerRemoveAll = func(ctx context.Context, w io.Writer, projectId string) error {
			return nil
		}
		listProjectVolumes = func(ctx context.Context, projectId string) ([]utils.VolumeInfo, error) {
			return []utils.VolumeInfo{{Name: "test-volume"}}, nil
		}

		// Run test
		err := Run(context.Background(), false, "test-project", false, afero.NewMemMapFs())

		// Assert
		require.NoError(t, err)
		assert.Contains(t, utils.CmdSuggestion, "container volume list")
		assert.Contains(t, utils.CmdSuggestion, "jq")
		assert.Contains(t, utils.CmdSuggestion, "test-project")
	})

	t.Run("shows docker volume suggestion on docker runtime", func(t *testing.T) {
		// Save original state
		originalRuntime := utils.Config.Runtime.Backend
		originalStopForwarders := stopAppleAnalyticsForwarders
		originalRemoveAll := dockerRemoveAll
		originalListVolumes := listProjectVolumes

		// Setup cleanup
		t.Cleanup(func() {
			utils.Config.Runtime.Backend = originalRuntime
			stopAppleAnalyticsForwarders = originalStopForwarders
			dockerRemoveAll = originalRemoveAll
			listProjectVolumes = originalListVolumes
			utils.CmdSuggestion = ""
		})

		// Set Docker runtime
		utils.Config.Runtime.Backend = config.DockerRuntime
		utils.Config.ProjectId = "test-project"

		// Mock the dependencies
		stopAppleAnalyticsForwarders = func(fsys afero.Fs) error {
			return nil
		}
		dockerRemoveAll = func(ctx context.Context, w io.Writer, projectId string) error {
			return nil
		}
		listProjectVolumes = func(ctx context.Context, projectId string) ([]utils.VolumeInfo, error) {
			return []utils.VolumeInfo{{Name: "test-volume"}}, nil
		}

		// Run test
		err := Run(context.Background(), false, "test-project", false, afero.NewMemMapFs())

		// Assert
		require.NoError(t, err)
		assert.Contains(t, utils.CmdSuggestion, "docker volume ls")
		assert.NotContains(t, utils.CmdSuggestion, "container volume list")
	})

	t.Run("stops apple analytics forwarders before docker remove all", func(t *testing.T) {
		// This test verifies the order: StopAppleAnalyticsForwarders is called BEFORE stop()
		// Save original state
		originalRuntime := utils.Config.Runtime.Backend
		originalStopForwarders := stopAppleAnalyticsForwarders
		originalRemoveAll := dockerRemoveAll
		originalListVolumes := listProjectVolumes

		// Setup cleanup
		t.Cleanup(func() {
			utils.Config.Runtime.Backend = originalRuntime
			stopAppleAnalyticsForwarders = originalStopForwarders
			dockerRemoveAll = originalRemoveAll
			listProjectVolumes = originalListVolumes
		})

		// Set Apple container runtime
		utils.Config.Runtime.Backend = config.AppleContainerRuntime
		utils.Config.ProjectId = "test-project"

		// Track call order
		var callOrder []string

		// Mock the dependencies
		stopAppleAnalyticsForwarders = func(fsys afero.Fs) error {
			callOrder = append(callOrder, "forwarder")
			return nil
		}
		dockerRemoveAll = func(ctx context.Context, w io.Writer, projectId string) error {
			callOrder = append(callOrder, "removeAll")
			return nil
		}
		listProjectVolumes = func(ctx context.Context, projectId string) ([]utils.VolumeInfo, error) {
			return nil, nil
		}

		// Run test
		err := Run(context.Background(), false, "test-project", false, afero.NewMemMapFs())

		// Assert
		require.NoError(t, err)
		require.Len(t, callOrder, 2)
		assert.Equal(t, "forwarder", callOrder[0], "Forwarder should be stopped before containers")
		assert.Equal(t, "removeAll", callOrder[1], "Containers should be removed after forwarder stops")
	})
}
