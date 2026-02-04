package sandbox

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"runtime"
	"time"

	"github.com/go-errors/errors"
	"github.com/olekukonko/tablewriter"
	"github.com/olekukonko/tablewriter/tw"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
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
	if cmd.Env == nil {
		cmd.Env = os.Environ()
	}
	switch runtime.GOOS {
	case "darwin":
		cmd.Env = append(cmd.Env, "DYLD_LIBRARY_PATH="+libDir)
	case "linux":
		cmd.Env = append(cmd.Env, "LD_LIBRARY_PATH="+libDir)
	}

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
		Timeout: 2 * time.Second,
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

// PrintStatus prints the sandbox status in a formatted table.
func PrintStatus(w io.Writer, statuses []ServiceStatus, ports *AllocatedPorts, projectId string) {
	fmt.Fprintf(w, "%s sandbox is running.\n\n", utils.Aqua("supabase"))

	// Services status table
	table := tablewriter.NewTable(w,
		tablewriter.WithSymbols(tw.NewSymbols(tw.StyleRounded)),
		tablewriter.WithConfig(tablewriter.Config{
			Header: tw.CellConfig{
				Formatting: tw.CellFormatting{
					AutoFormat: tw.Off,
				},
				Alignment: tw.CellAlignment{
					Global: tw.AlignLeft,
				},
			},
			Row: tw.CellConfig{
				Alignment: tw.CellAlignment{
					Global: tw.AlignLeft,
				},
			},
		}),
		tablewriter.WithHeader([]string{"Service", "Status", "Port"}),
	)

	for _, s := range statuses {
		statusStr := s.Status
		if s.Healthy {
			statusStr = utils.Green(statusStr)
		} else {
			statusStr = utils.Red(statusStr)
		}
		portStr := fmt.Sprintf("%d", s.Port)
		if s.Port == 0 {
			portStr = "-"
		}
		table.Append(s.Name, statusStr, portStr)
	}
	table.Render()
	fmt.Fprintln(w)

	// Connection info
	fmt.Fprintln(w, utils.Bold("Connection Info:"))
	fmt.Fprintf(w, "  API URL:       %s\n", utils.Aqua(fmt.Sprintf("http://127.0.0.1:%d", ports.API)))
	fmt.Fprintf(w, "  REST URL:      %s\n", utils.Aqua(fmt.Sprintf("http://127.0.0.1:%d/rest/v1/", ports.API)))
	fmt.Fprintf(w, "  Auth URL:      %s\n", utils.Aqua(fmt.Sprintf("http://127.0.0.1:%d/auth/v1/", ports.API)))
	fmt.Fprintf(w, "  DB URL:        %s\n", utils.Aqua(fmt.Sprintf("postgresql://%s@127.0.0.1:%d/postgres",
		url.UserPassword("postgres", utils.Config.Db.Password), ports.Postgres)))
	fmt.Fprintln(w)
}

// ShowStatus checks sandbox status and prints it.
func ShowStatus(ctx context.Context, projectId string, fsys afero.Fs) error {
	sandboxCtx, err := NewSandboxContext(projectId)
	if err != nil {
		return fmt.Errorf("failed to create sandbox context: %w", err)
	}

	// Load state
	state, err := sandboxCtx.LoadState(fsys)
	if err != nil {
		return errors.Errorf("sandbox is not running: %w", err)
	}

	// Get status of all services
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

	PrintStatus(os.Stdout, statuses, &state.Ports, projectId)
	return nil
}
