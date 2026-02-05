package sandbox

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"

	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
)

// SandboxPostgresVersionPath stores the postgres version persistently.
// This follows the same pattern as PostgresVersionPath, GotrueVersionPath, etc. in misc.go.
// Located in TempDir (not ConfigDir) so it survives stop but is still project-local.
var SandboxPostgresVersionPath = filepath.Join(utils.TempDir, "sandbox-postgres-version")

// SandboxContext holds project-specific runtime context for sandbox mode.
// It includes paths, allocated ports, and helper methods for resource naming.
type SandboxContext struct {
	ProjectId string
	Ports     *AllocatedPorts
	ConfigDir string // supabase/.temp/ (project-local temp directory)
	BinDir    string // ~/.supabase/sandbox/bin/ (shared across projects)
}

// NewSandboxContext creates a new sandbox context for the given project.
func NewSandboxContext(projectId string) (*SandboxContext, error) {
	homeDir, err := os.UserHomeDir()
	if err != nil {
		return nil, fmt.Errorf("failed to get home directory: %w", err)
	}

	return &SandboxContext{
		ProjectId: projectId,
		ConfigDir: filepath.Join(utils.TempDir, "sandbox"),
		BinDir:    filepath.Join(homeDir, ".supabase", "bin"),
	}, nil
}

// StateFilePath returns the path to the state.json file for this project.
func (c *SandboxContext) StateFilePath() string {
	return filepath.Join(c.ConfigDir, "state.json")
}

// LogDir returns the path to the logs directory for this project.
func (c *SandboxContext) LogDir() string {
	return filepath.Join(c.ConfigDir, "logs")
}

// PgDataDir returns the path to the postgres data directory.
// IMPORTANT: This is stored OUTSIDE ConfigDir (.temp/sandbox/) so it persists between start/stop.
// Location: supabase/.temp/pgdata/
func (c *SandboxContext) PgDataDir() string {
	return filepath.Join(utils.TempDir, "pgdata")
}

// EnsureDirectories creates all necessary directories for the sandbox.
func (c *SandboxContext) EnsureDirectories(fsys afero.Fs) error {
	dirs := []string{
		c.ConfigDir,
		c.BinDir,
		c.LogDir(),
		c.PgDataDir(),
	}

	for _, dir := range dirs {
		if err := fsys.MkdirAll(dir, 0755); err != nil {
			return fmt.Errorf("failed to create directory %s: %w", dir, err)
		}
	}
	return nil
}

// SaveState persists the sandbox state (PID + ports) to state.json.
func (c *SandboxContext) SaveState(fsys afero.Fs, state *SandboxState) error {
	data, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to marshal state: %w", err)
	}
	if err := afero.WriteFile(fsys, c.StateFilePath(), data, 0644); err != nil {
		return fmt.Errorf("failed to write state file: %w", err)
	}
	return nil
}

// LoadState reads the sandbox state from state.json.
func (c *SandboxContext) LoadState(fsys afero.Fs) (*SandboxState, error) {
	data, err := afero.ReadFile(fsys, c.StateFilePath())
	if err != nil {
		return nil, err
	}
	var state SandboxState
	if err := json.Unmarshal(data, &state); err != nil {
		return nil, fmt.Errorf("failed to unmarshal state: %w", err)
	}
	return &state, nil
}

// CleanupState removes the state file.
func (c *SandboxContext) CleanupState(fsys afero.Fs) error {
	if err := fsys.Remove(c.StateFilePath()); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("failed to remove state file: %w", err)
	}
	return nil
}

// IsSandboxRunning checks if sandbox is running by verifying state file exists
// AND the server PID is still alive.
func (c *SandboxContext) IsSandboxRunning(fsys afero.Fs) bool {
	state, err := c.LoadState(fsys)
	if err != nil {
		return false
	}
	return processExists(state.PID)
}

// processExists checks if a process with the given PID is still running.
func processExists(pid int) bool {
	if pid <= 0 {
		return false
	}
	process, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	// On Unix, FindProcess always succeeds. We need to send signal 0 to check if process exists.
	err = process.Signal(syscall.Signal(0))
	return err == nil
}

// IsSandboxRunning checks if a sandbox instance is running for the given project.
// This is a convenience function for external callers.
func IsSandboxRunning(fsys afero.Fs, projectId string) bool {
	ctx, err := NewSandboxContext(projectId)
	if err != nil {
		return false
	}
	return ctx.IsSandboxRunning(fsys)
}

// SavePostgresVersion writes the postgres version to a persistent file.
// This survives stop/start cycles since it's in TempDir, not ConfigDir.
func SavePostgresVersion(fsys afero.Fs, version string) error {
	return utils.WriteFile(SandboxPostgresVersionPath, []byte(version), fsys)
}

// LoadPostgresVersion reads the postgres version from the persistent file.
func LoadPostgresVersion(fsys afero.Fs) (string, error) {
	data, err := afero.ReadFile(fsys, SandboxPostgresVersionPath)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(data)), nil
}
