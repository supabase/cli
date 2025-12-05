package mcpinit

import (
	"context"
	"os/exec"

	"github.com/spf13/afero"
)

// Client represents an MCP client that can be configured
type Client interface {
	// Name returns the client identifier (e.g., "claude-code")
	Name() string

	// DisplayName returns the human-readable name (e.g., "Claude Code")
	DisplayName() string

	// IsInstalled checks if the client is installed on the system
	IsInstalled() bool

	// InstallInstructions returns instructions for installing the client
	InstallInstructions() string

	// Configure performs the configuration for this client
	Configure(ctx context.Context, fsys afero.Fs) error
}

// baseClient provides default implementations for the Client interface
type baseClient struct {
	name                string
	displayName         string
	installInstructions string
	checkInstalled      func() bool
}

func (b *baseClient) Name() string {
	return b.name
}

func (b *baseClient) DisplayName() string {
	return b.displayName
}

func (b *baseClient) IsInstalled() bool {
	if b.checkInstalled != nil {
		return b.checkInstalled()
	}
	return false
}

func (b *baseClient) InstallInstructions() string {
	return b.installInstructions
}

// commandExists checks if a command-line tool is available
func commandExists(command string) bool {
	_, err := exec.LookPath(command)
	return err == nil
}
