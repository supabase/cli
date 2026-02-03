package sandbox

import (
	"context"
	"fmt"
	"net"
)

const (
	DefaultNginxPort    = 54321
	DefaultPostgresPort = 54322

	MaxPortSearchAttempts = 100
)

// AllocatedPorts holds the dynamically allocated ports for each service.
// User-facing ports (Nginx, Postgres) are allocated sequentially from defaults.
// Internal ports (GoTrue, PostgREST, ProcessCompose) are allocated randomly.
type AllocatedPorts struct {
	Postgres       int `json:"postgres"`
	Nginx          int `json:"nginx"`
	GoTrue         int `json:"gotrue"`
	PostgREST      int `json:"postgrest"`
	PostgRESTAdmin int `json:"postgrest_admin"`
	ProcessCompose int `json:"process_compose"`
}

// AllocatePorts finds available ports for all sandbox services.
// User-facing ports are sequential, internal ports are random.
func AllocatePorts(ctx context.Context) (*AllocatedPorts, error) {
	ports := &AllocatedPorts{}
	var err error

	// User-facing ports: sequential from defaults
	ports.Nginx, err = findAvailablePortSequential(DefaultNginxPort)
	if err != nil {
		return nil, fmt.Errorf("nginx port: %w", err)
	}

	ports.Postgres, err = findAvailablePortSequential(DefaultPostgresPort)
	if err != nil {
		return nil, fmt.Errorf("postgres port: %w", err)
	}

	// Internal ports: random (behind nginx reverse proxy)
	ports.GoTrue, err = findAvailablePortRandom()
	if err != nil {
		return nil, fmt.Errorf("gotrue port: %w", err)
	}

	ports.PostgREST, err = findAvailablePortRandom()
	if err != nil {
		return nil, fmt.Errorf("postgrest port: %w", err)
	}

	ports.PostgRESTAdmin, err = findAvailablePortRandom()
	if err != nil {
		return nil, fmt.Errorf("postgrest admin port: %w", err)
	}

	ports.ProcessCompose, err = findAvailablePortRandom()
	if err != nil {
		return nil, fmt.Errorf("process-compose server port: %w", err)
	}

	return ports, nil
}

// findAvailablePortSequential searches for an available port starting from defaultPort.
// It tries up to MaxPortSearchAttempts sequential ports before failing.
func findAvailablePortSequential(defaultPort int) (int, error) {
	for offset := 0; offset < MaxPortSearchAttempts; offset++ {
		port := defaultPort + offset
		if port > 65535 {
			break
		}
		if isPortAvailable(port) {
			return port, nil
		}
	}
	return 0, fmt.Errorf("no available port found starting from %d (tried %d ports)",
		defaultPort, MaxPortSearchAttempts)
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

// isPortAvailable checks if a TCP port is available on localhost.
func isPortAvailable(port int) bool {
	listener, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
	if err != nil {
		return false
	}
	listener.Close()
	return true
}
