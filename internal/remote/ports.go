package remote

import (
	"context"
	"fmt"

	"github.com/go-errors/errors"
	"github.com/supabase/cli/internal/utils"
)

// DockerAPIPort is the TCP port for Docker daemon API access
const DockerAPIPort uint16 = 2375

// PortMapping defines a local-to-remote port mapping
type PortMapping struct {
	Name       string
	LocalPort  uint16
	RemotePort uint16
}

// GetSupabasePortMappings returns the port mappings for Supabase services
// based on the current configuration
func GetSupabasePortMappings() []PortMapping {
	return []PortMapping{
		{Name: "API", LocalPort: utils.Config.Api.Port, RemotePort: utils.Config.Api.Port},
		{Name: "DB", LocalPort: utils.Config.Db.Port, RemotePort: utils.Config.Db.Port},
		{Name: "Inbucket", LocalPort: utils.Config.Inbucket.Port, RemotePort: utils.Config.Inbucket.Port},
		{Name: "Docker", LocalPort: DockerAPIPort, RemotePort: DockerAPIPort},
	}
}

// ForwardAllSupabasePorts sets up port forwards for all Supabase services
func (s *Session) ForwardAllSupabasePorts(ctx context.Context) error {
	mappings := GetSupabasePortMappings()

	// Deduplicate ports (some services share ports)
	seen := make(map[uint16]bool)
	var uniqueMappings []PortMapping

	for _, m := range mappings {
		if !seen[m.LocalPort] {
			seen[m.LocalPort] = true
			uniqueMappings = append(uniqueMappings, m)
		}
	}

	fmt.Println("Setting up port forwards...")
	for _, m := range uniqueMappings {
		fmt.Printf("  %s: localhost:%d -> remote:%d\n", m.Name, m.LocalPort, m.RemotePort)
		if err := s.ForwardPort(ctx, int(m.LocalPort), int(m.RemotePort)); err != nil {
			return errors.Errorf("failed to forward port for %s: %w", m.Name, err)
		}
	}

	return nil
}

// PrintConnectionInfo prints the connection information for the user
func PrintConnectionInfo() {
	mappings := GetSupabasePortMappings()

	fmt.Println("\nRemote Supabase services are now available locally:")
	fmt.Println()

	seen := make(map[uint16]bool)
	for _, m := range mappings {
		if !seen[m.LocalPort] {
			seen[m.LocalPort] = true
			fmt.Printf("  %-12s: http://localhost:%d\n", m.Name, m.LocalPort)
		}
	}
}
