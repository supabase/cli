package sandbox

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"github.com/spf13/afero"
)

// SandboxContext holds project-specific runtime context for sandbox mode.
// It includes paths, allocated ports, and helper methods for resource naming.
type SandboxContext struct {
	ProjectId string
	Ports     *AllocatedPorts
	ConfigDir string // .supabase/sandbox/<projectId>/ (project-specific)
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
		ConfigDir: filepath.Join(".supabase", "sandbox", projectId),
		BinDir:    filepath.Join(homeDir, ".supabase", "sandbox", "bin"),
	}, nil
}

// ContainerName returns the namespaced Docker container name for a service.
// Format: supabase_<service>_<projectId>
func (c *SandboxContext) ContainerName(service string) string {
	return fmt.Sprintf("supabase_%s_%s", service, c.ProjectId)
}

// VolumeName returns the namespaced Docker volume name for a service.
// Format: supabase_<service>_<projectId>
func (c *SandboxContext) VolumeName(service string) string {
	return fmt.Sprintf("supabase_%s_%s", service, c.ProjectId)
}

// NginxConfigPath returns the path to the nginx.conf file for this project.
func (c *SandboxContext) NginxConfigPath() string {
	return filepath.Join(c.ConfigDir, "nginx.conf")
}

// PortsFilePath returns the path to the ports.json state file for this project.
func (c *SandboxContext) PortsFilePath() string {
	return filepath.Join(c.ConfigDir, "ports.json")
}

// LogDir returns the path to the logs directory for this project.
func (c *SandboxContext) LogDir() string {
	return filepath.Join(c.ConfigDir, "logs")
}

// EnsureDirectories creates all necessary directories for the sandbox.
func (c *SandboxContext) EnsureDirectories(fsys afero.Fs) error {
	dirs := []string{
		c.ConfigDir,
		c.BinDir,
		c.LogDir(),
	}

	for _, dir := range dirs {
		if err := fsys.MkdirAll(dir, 0755); err != nil {
			return fmt.Errorf("failed to create directory %s: %w", dir, err)
		}
	}
	return nil
}

// SavePorts persists the allocated ports to a JSON file.
// This allows supabase stop to find running instances.
func (c *SandboxContext) SavePorts(fsys afero.Fs) error {
	data, err := json.MarshalIndent(c.Ports, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to marshal ports: %w", err)
	}
	if err := afero.WriteFile(fsys, c.PortsFilePath(), data, 0644); err != nil {
		return fmt.Errorf("failed to write ports file: %w", err)
	}
	return nil
}

// LoadPorts reads the allocated ports from the state file.
func (c *SandboxContext) LoadPorts(fsys afero.Fs) (*AllocatedPorts, error) {
	data, err := afero.ReadFile(fsys, c.PortsFilePath())
	if err != nil {
		return nil, fmt.Errorf("failed to read ports file: %w", err)
	}
	var ports AllocatedPorts
	if err := json.Unmarshal(data, &ports); err != nil {
		return nil, fmt.Errorf("failed to unmarshal ports: %w", err)
	}
	return &ports, nil
}

// PidsFilePath returns the path to the pids.json state file for this project.
func (c *SandboxContext) PidsFilePath() string {
	return filepath.Join(c.ConfigDir, "pids.json")
}

// ProcessPids holds PIDs of running native processes for shutdown.
type ProcessPids struct {
	Nginx     int `json:"nginx"`
	GoTrue    int `json:"gotrue"`
	PostgREST int `json:"postgrest"`
}

// SavePids persists the process PIDs to a JSON file.
func (c *SandboxContext) SavePids(fsys afero.Fs, pids *ProcessPids) error {
	data, err := json.MarshalIndent(pids, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to marshal pids: %w", err)
	}
	if err := afero.WriteFile(fsys, c.PidsFilePath(), data, 0644); err != nil {
		return fmt.Errorf("failed to write pids file: %w", err)
	}
	return nil
}

// LoadPids reads the process PIDs from the state file.
func (c *SandboxContext) LoadPids(fsys afero.Fs) (*ProcessPids, error) {
	data, err := afero.ReadFile(fsys, c.PidsFilePath())
	if err != nil {
		return nil, fmt.Errorf("failed to read pids file: %w", err)
	}
	var pids ProcessPids
	if err := json.Unmarshal(data, &pids); err != nil {
		return nil, fmt.Errorf("failed to unmarshal pids: %w", err)
	}
	return &pids, nil
}

// CleanupState removes the ports file and other state files.
func (c *SandboxContext) CleanupState(fsys afero.Fs) error {
	// Remove ports file
	if err := fsys.Remove(c.PortsFilePath()); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("failed to remove ports file: %w", err)
	}
	// Remove pids file
	if err := fsys.Remove(c.PidsFilePath()); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("failed to remove pids file: %w", err)
	}
	return nil
}

// IsSandboxRunning checks if a sandbox instance is running by checking for the ports file.
func IsSandboxRunning(fsys afero.Fs, projectId string) bool {
	ctx, err := NewSandboxContext(projectId)
	if err != nil {
		return false
	}
	_, err = fsys.Stat(ctx.PortsFilePath())
	return err == nil
}
