package sandbox

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"time"

	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
)

const (
	// HealthCheckTimeout is the timeout for HTTP health check requests.
	HealthCheckTimeout = 2 * time.Second
)

// ServiceStatus represents the health status of a service.
type ServiceStatus struct {
	Name    string
	Status  string
	Port    int
	Healthy bool
}

// Status checks the health of all sandbox services for the given project.
func Status(ctx context.Context, projectId string, fsys afero.Fs) ([]ServiceStatus, error) {
	sandboxCtx, err := NewSandboxContext(projectId)
	if err != nil {
		return nil, fmt.Errorf("failed to create sandbox context: %w", err)
	}

	// Load state to find services
	state, err := sandboxCtx.LoadState(fsys)
	if err != nil {
		return nil, fmt.Errorf("sandbox is not running (no state file): %w", err)
	}

	var statuses []ServiceStatus

	// Check postgres (native process using pg_isready)
	pgStatus := checkPostgresStatus(ctx, fsys, sandboxCtx.BinDir, state.Ports.Postgres)
	statuses = append(statuses, pgStatus)

	// Check gotrue (native process)
	gotrueStatus := checkHTTPStatus("gotrue", state.Ports.GoTrue, "/health")
	statuses = append(statuses, gotrueStatus)

	// Check postgrest (native process)
	postgrestStatus := checkHTTPStatus("postgrest", state.Ports.PostgREST, "/")
	statuses = append(statuses, postgrestStatus)

	// Check api proxy (process-compose managed)
	apiStatus := checkHTTPStatus("api", state.Ports.API, "/health")
	statuses = append(statuses, apiStatus)

	return statuses, nil
}

// checkPostgresStatus checks if native postgres is healthy using pg_isready.
func checkPostgresStatus(ctx context.Context, fsys afero.Fs, binDir string, port int) ServiceStatus {
	status := ServiceStatus{
		Name: "postgres",
		Port: port,
	}

	if port == 0 {
		status.Status = "not configured"
		status.Healthy = false
		return status
	}

	// Load postgres version from persistent file
	postgresVersion, err := LoadPostgresVersion(fsys)
	if err != nil {
		status.Status = "unknown version"
		status.Healthy = false
		return status
	}

	// Use pg_isready to check postgres health
	pgIsReady := GetPostgresBinPath(binDir, postgresVersion, "pg_isready")
	cmd := exec.CommandContext(ctx, pgIsReady,
		"-h", "127.0.0.1",
		"-p", fmt.Sprintf("%d", port),
		"-U", "postgres",
	)

	// Set library path for shared libraries
	libDir := GetPostgresLibDir(binDir, postgresVersion)
	setLibraryPath(cmd, libDir)

	if err := cmd.Run(); err != nil {
		status.Status = "not responding"
		status.Healthy = false
		return status
	}

	status.Status = "running"
	status.Healthy = true
	return status
}

// checkHTTPStatus checks if a service is responding to HTTP requests.
func checkHTTPStatus(name string, port int, path string) ServiceStatus {
	status := ServiceStatus{
		Name: name,
		Port: port,
	}

	if port == 0 {
		status.Status = "not configured"
		status.Healthy = false
		return status
	}

	client := &http.Client{
		Timeout: HealthCheckTimeout,
	}

	url := fmt.Sprintf("http://127.0.0.1:%d%s", port, path)
	resp, err := client.Get(url)
	if err != nil {
		status.Status = "not responding"
		status.Healthy = false
		return status
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 200 && resp.StatusCode < 400 {
		status.Status = "running"
		status.Healthy = true
	} else {
		status.Status = fmt.Sprintf("unhealthy (%d)", resp.StatusCode)
		status.Healthy = false
	}

	return status
}

// ShowStatus checks sandbox status and prints it using the same format as Docker mode.
func ShowStatus(ctx context.Context, projectId string, fsys afero.Fs) error {
	sandboxCtx, err := NewSandboxContext(projectId)
	if err != nil {
		return fmt.Errorf("failed to create sandbox context: %w", err)
	}

	// Load state
	state, err := sandboxCtx.LoadState(fsys)
	if err != nil {
		return fmt.Errorf("sandbox is not running: %w", err)
	}

	// Set ports from state so PrettyPrintSandbox can use them
	sandboxCtx.Ports = &state.Ports

	// Get status of all services to check for unhealthy ones
	statuses, err := Status(ctx, projectId, fsys)
	if err != nil {
		return err
	}

	// Check if any service is unhealthy
	var unhealthy []string
	for _, s := range statuses {
		if !s.Healthy {
			unhealthy = append(unhealthy, s.Name)
		}
	}

	if len(unhealthy) > 0 {
		fmt.Fprintf(os.Stderr, "Unhealthy services: %v\n", unhealthy)
	}

	// Print status message matching Docker mode
	fmt.Fprintf(os.Stderr, "%s local development setup is running.\n\n", utils.Aqua("supabase"))

	// Print tables using the same format as start --sandbox
	PrettyPrintSandbox(os.Stdout, sandboxCtx)
	return nil
}
