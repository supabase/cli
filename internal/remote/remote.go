package remote

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/docker/docker/client"
	"github.com/go-errors/errors"
	"github.com/spf13/viper"
)

// Session represents an active remote Docker session
type Session struct {
	SandboxID  string    `json:"sandbox_id"`
	SSHConfig  SSHConfig `json:"ssh_config"`
	ProjectID  string    `json:"project_id"`

	sshClient       *SSHClient
	dockerClient    *client.Client
	portForwards    []portForward
	keepaliveCancel context.CancelFunc
	mu              sync.Mutex
}

type portForward struct {
	LocalPort  int
	RemotePort int
	cancel     context.CancelFunc
}

// SessionFile returns the path to the session state file
func SessionFile() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".supabase", "remote-session.json")
}

// LoadSession loads an existing session from disk
func LoadSession() (*Session, error) {
	data, err := os.ReadFile(SessionFile())
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, errors.Errorf("failed to read session file: %w", err)
	}

	var session Session
	if err := json.Unmarshal(data, &session); err != nil {
		return nil, errors.Errorf("failed to parse session file: %w", err)
	}

	return &session, nil
}

// Save persists the session state to disk
func (s *Session) Save() error {
	s.mu.Lock()
	defer s.mu.Unlock()

	data, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return errors.Errorf("failed to serialize session: %w", err)
	}

	dir := filepath.Dir(SessionFile())
	if err := os.MkdirAll(dir, 0755); err != nil {
		return errors.Errorf("failed to create session directory: %w", err)
	}

	if err := os.WriteFile(SessionFile(), data, 0600); err != nil {
		return errors.Errorf("failed to write session file: %w", err)
	}

	return nil
}

// Delete removes the session state file
func (s *Session) Delete() error {
	return os.Remove(SessionFile())
}

// Connect establishes SSH connection to the remote VM
func (s *Session) Connect() error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.sshClient != nil {
		return nil // Already connected
	}

	sshClient, err := NewSSHClient(s.SSHConfig)
	if err != nil {
		return err
	}

	s.sshClient = sshClient
	return nil
}

// Close closes all connections and cleans up resources
func (s *Session) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()

	// Cancel keepalive goroutine
	if s.keepaliveCancel != nil {
		s.keepaliveCancel()
		s.keepaliveCancel = nil
	}

	// Cancel all port forwards
	for _, pf := range s.portForwards {
		if pf.cancel != nil {
			pf.cancel()
		}
	}
	s.portForwards = nil

	// Close Docker client
	if s.dockerClient != nil {
		s.dockerClient.Close()
		s.dockerClient = nil
	}

	// Close SSH connection
	if s.sshClient != nil {
		s.sshClient.Close()
		s.sshClient = nil
	}

	return nil
}

// GetDockerClient returns a Docker client configured to use the remote daemon
func (s *Session) GetDockerClient() (*client.Client, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.dockerClient != nil {
		return s.dockerClient, nil
	}

	if s.sshClient == nil {
		return nil, errors.New("SSH connection not established")
	}

	// Create Docker client with custom dialer using dial-stdio
	dockerClient, err := client.NewClientWithOpts(
		client.WithDialContext(func(ctx context.Context, network, addr string) (net.Conn, error) {
			return s.sshClient.DialDockerStdio(ctx)
		}),
		client.WithAPIVersionNegotiation(),
	)
	if err != nil {
		return nil, errors.Errorf("failed to create Docker client: %w", err)
	}

	s.dockerClient = dockerClient
	return dockerClient, nil
}

// Exec runs a command on the remote host
func (s *Session) Exec(ctx context.Context, cmd string) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.sshClient == nil {
		return "", errors.New("SSH connection not established")
	}

	return s.sshClient.Exec(ctx, cmd)
}

// ForwardPort sets up a local port forward to the remote VM
func (s *Session) ForwardPort(ctx context.Context, localPort, remotePort int) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.sshClient == nil {
		return errors.New("SSH connection not established")
	}

	ctx, cancel := context.WithCancel(ctx)

	localAddr := fmt.Sprintf("127.0.0.1:%d", localPort)
	remoteAddr := fmt.Sprintf("127.0.0.1:%d", remotePort)

	if err := s.sshClient.ForwardPort(ctx, localAddr, remoteAddr); err != nil {
		cancel()
		return err
	}

	s.portForwards = append(s.portForwards, portForward{
		LocalPort:  localPort,
		RemotePort: remotePort,
		cancel:     cancel,
	})

	return nil
}

// StartRemoteSession creates or reconnects to a remote session with Daytona.
// Returns the session and a boolean indicating if this was a cold start (VM was stopped/new).
// Cold start means Docker daemon needs to be restarted; warm reconnect means it's still running.
func StartRemoteSession(ctx context.Context, projectID string) (*Session, bool, error) {
	daytona, err := NewDaytonaClient()
	if err != nil {
		return nil, false, err
	}

	// Check for existing session file
	existing, err := LoadSession()
	if err != nil {
		return nil, false, err
	}

	var sandboxID string
	coldStart := true // Assume cold start unless we find a running VM

	if existing != nil {
		// Try to reuse existing sandbox
		fmt.Printf("Found existing session (sandbox: %s), checking status...\n", existing.SandboxID)
		info, err := daytona.Status(ctx, existing.SandboxID)
		if err != nil {
			// Sandbox is gone (404 or other error), create new one
			fmt.Println("Existing sandbox not found, creating new one...")
			sandboxID, err = createNewSandbox(ctx, daytona)
			if err != nil {
				return nil, false, err
			}
		} else {
			// Sandbox exists, check if we need to start it
			fmt.Printf("Sandbox state: %s\n", info.Status)
			if info.Status == "stopped" || info.Status == "archived" {
				fmt.Printf("Starting %s sandbox...\n", info.Status)
				if err := daytona.Start(ctx, existing.SandboxID); err != nil {
					return nil, false, errors.Errorf("failed to start sandbox: %w", err)
				}
				// Wait for it to be ready
				if err := waitForSandboxReady(ctx, daytona, existing.SandboxID); err != nil {
					return nil, false, err
				}
			} else if info.Status == "started" {
				// VM was already running - warm reconnect
				coldStart = false
			} else {
				// Unexpected state, create new
				fmt.Printf("Sandbox in unexpected state (%s), creating new one...\n", info.Status)
				sandboxID, err = createNewSandbox(ctx, daytona)
				if err != nil {
					return nil, false, err
				}
			}
			if sandboxID == "" {
				sandboxID = existing.SandboxID
			}
		}
	} else {
		// No existing session, create new sandbox
		fmt.Println("Creating remote Docker environment...")
		sandboxID, err = createNewSandbox(ctx, daytona)
		if err != nil {
			return nil, false, err
		}
	}

	// Get fresh SSH credentials (tokens expire)
	fmt.Println("Getting SSH access credentials...")
	sshConfig, err := daytona.GetSSHAccess(ctx, sandboxID)
	if err != nil {
		return nil, false, errors.Errorf("failed to get SSH access: %w", err)
	}

	session := &Session{
		SandboxID: sandboxID,
		SSHConfig: *sshConfig,
		ProjectID: projectID,
	}

	// Save session state (update sandbox ID if it changed)
	if err := session.Save(); err != nil {
		return nil, false, err
	}

	// Establish SSH connection
	if err := session.Connect(); err != nil {
		return nil, false, err
	}

	// Start keepalive goroutine to prevent auto-stop
	// SSH connections alone do NOT count as activity for Daytona's auto-stop
	session.startKeepalive(daytona)

	return session, coldStart, nil
}

// startKeepalive starts a goroutine that periodically refreshes activity to prevent auto-stop
func (s *Session) startKeepalive(daytona *DaytonaClient) {
	ctx, cancel := context.WithCancel(context.Background())
	s.keepaliveCancel = cancel

	go func() {
		ticker := time.NewTicker(30 * time.Second) // Refresh every 30 seconds
		defer ticker.Stop()

		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if err := daytona.RefreshActivity(context.Background(), s.SandboxID); err != nil {
					// Log but don't fail - keepalive is best effort
					fmt.Fprintf(os.Stderr, "Warning: keepalive failed: %v\n", err)
				}
			}
		}
	}()
}

// createNewSandbox creates a new Daytona sandbox and waits for it to be ready
func createNewSandbox(ctx context.Context, daytona *DaytonaClient) (string, error) {
	info, err := daytona.Create(ctx)
	if err != nil {
		return "", errors.Errorf("failed to create remote environment: %w", err)
	}

	if err := waitForSandboxReady(ctx, daytona, info.ID); err != nil {
		daytona.Destroy(ctx, info.ID)
		return "", err
	}

	return info.ID, nil
}

// waitForSandboxReady waits for a sandbox to reach "started" state
func waitForSandboxReady(ctx context.Context, daytona *DaytonaClient, sandboxID string) error {
	fmt.Println("Waiting for sandbox to be ready...")
	for {
		info, err := daytona.Status(ctx, sandboxID)
		if err != nil {
			return errors.Errorf("failed to get sandbox status: %w", err)
		}
		fmt.Printf("Sandbox state: %s\n", info.Status)

		if info.Status == "started" {
			fmt.Println("Sandbox is ready!")
			return nil
		}

		if info.Status == "error" || info.Status == "failed" {
			return errors.Errorf("sandbox failed to start (state: %s)", info.Status)
		}

		time.Sleep(2 * time.Second)
	}
}

// StopRemoteSession disconnects from the remote session.
// The VM will auto-stop after 1m of no SSH connection (configured on creation).
func StopRemoteSession(ctx context.Context) error {
	session, err := LoadSession()
	if err != nil {
		return err
	}
	if session == nil {
		return nil // No session to stop, that's fine
	}

	// Close connections (SSH, port forwards, docker client)
	session.Close()

	// Keep session file - allows quick restart
	fmt.Println("Disconnected. VM will auto-stop in 1m, archive in 10m, delete in 30m.")

	return nil
}

// GetRemoteSession returns the current remote session if one exists
func GetRemoteSession() (*Session, error) {
	session, err := LoadSession()
	if err != nil {
		return nil, err
	}
	if session == nil {
		return nil, errors.New("no active remote session found")
	}
	return session, nil
}

// IsRemoteActive checks if a remote session is active by verifying the Docker API port is accessible.
// This is used by other CLI commands to determine if they should use remote Docker.
func IsRemoteActive() bool {
	// Check if session file exists
	session, err := LoadSession()
	if err != nil || session == nil {
		return false
	}

	// Check if Docker API port is accessible (meaning port forwards are running)
	conn, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", DockerAPIPort), 500*time.Millisecond)
	if err != nil {
		return false
	}
	conn.Close()
	return true
}

// GetRemoteDockerClient returns a Docker client connected to the remote daemon via forwarded port.
// This should be used by CLI commands when IsRemoteActive() returns true.
func GetRemoteDockerClient() (*client.Client, error) {
	return client.NewClientWithOpts(
		client.WithHost(fmt.Sprintf("tcp://127.0.0.1:%d", DockerAPIPort)),
		client.WithAPIVersionNegotiation(),
	)
}

// InitDockerClient is a callback that should be set by the utils package to allow
// remote package to update the global Docker client without circular imports.
// Usage: In cmd/root.go, set remote.InitDockerClient = func(c) { utils.Docker = c }
var InitDockerClient func(*client.Client)

// ConfigureDocker checks if a remote session is active and configures the global
// Docker client accordingly. This should be called early in CLI command execution.
// Returns true if remote mode is active.
func ConfigureDocker() bool {
	if !IsRemoteActive() {
		return false
	}

	remoteClient, err := GetRemoteDockerClient()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Warning: failed to create remote Docker client: %v\n", err)
		return false
	}

	if InitDockerClient != nil {
		InitDockerClient(remoteClient)
	}

	// Use Docker Hub registry (images are pre-pulled/mirrored in Daytona, public.ecr.aws not accessible)
	viper.Set("INTERNAL_IMAGE_REGISTRY", "docker.io")

	return true
}
