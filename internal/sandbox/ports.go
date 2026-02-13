package sandbox

import (
	"context"
	"fmt"
	"net"

	"github.com/supabase/cli/internal/utils"
)

// AllocatedPorts holds the dynamically allocated ports for each service.
// Ports are taken from config.toml if available, falling back to random ports.
type AllocatedPorts struct {
	API            int `json:"api"` // API gateway (reverse proxy)
	Postgres       int `json:"postgres"`
	GoTrue         int `json:"gotrue"`
	PostgREST      int `json:"postgrest"`
	PostgRESTAdmin int `json:"postgrest_admin"`
	ProcessCompose int `json:"process_compose"`
}

// SandboxState holds the complete runtime state for a sandbox instance.
// Stored in state.json - replaces both ports.json and pids.json.
type SandboxState struct {
	PID   int            `json:"pid"`   // _sandbox-server process ID
	Ports AllocatedPorts `json:"ports"` // Allocated ports for all services
}

// AllocatePorts finds available ports for all sandbox services.
// Uses ports from config.toml if available and not in use, otherwise allocates random ports.
func AllocatePorts(ctx context.Context) (*AllocatedPorts, error) {
	ports := &AllocatedPorts{}
	var err error

	// API port (from config.toml [api] port)
	ports.API, err = findAvailablePort(uint16(utils.Config.Api.Port))
	if err != nil {
		return nil, fmt.Errorf("api port: %w", err)
	}

	// Postgres port (from config.toml [db] port)
	ports.Postgres, err = findAvailablePort(uint16(utils.Config.Db.Port))
	if err != nil {
		return nil, fmt.Errorf("postgres port: %w", err)
	}

	// GoTrue doesn't have a config port (internal service), use random
	ports.GoTrue, err = findAvailablePortRandom()
	if err != nil {
		return nil, fmt.Errorf("gotrue port: %w", err)
	}

	// PostgREST doesn't have a config port, use random
	ports.PostgREST, err = findAvailablePortRandom()
	if err != nil {
		return nil, fmt.Errorf("postgrest port: %w", err)
	}

	// PostgREST Admin doesn't have a config port, use random
	ports.PostgRESTAdmin, err = findAvailablePortRandom()
	if err != nil {
		return nil, fmt.Errorf("postgrest admin port: %w", err)
	}

	// Process-compose server doesn't have a config port, use random
	ports.ProcessCompose, err = findAvailablePortRandom()
	if err != nil {
		return nil, fmt.Errorf("process-compose server port: %w", err)
	}

	return ports, nil
}

// findAvailablePort tries to use the preferred port from config, falls back to random if unavailable.
func findAvailablePort(preferred uint16) (int, error) {
	if preferred > 0 {
		// Try the configured port first
		if isPortAvailable(int(preferred)) {
			return int(preferred), nil
		}
		// Port is in use, fall back to random
	}
	return findAvailablePortRandom()
}

// isPortAvailable checks if a port is available for binding.
func isPortAvailable(port int) bool {
	listener, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
	if err != nil {
		return false
	}
	listener.Close()
	return true
}

// findAvailablePortRandom finds a random available port by letting the OS assign one.
func findAvailablePortRandom() (int, error) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, fmt.Errorf("failed to find available port: %w", err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	listener.Close()
	return port, nil
}
