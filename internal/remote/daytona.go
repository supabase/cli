package remote

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"time"

	"github.com/go-errors/errors"
)

const (
	defaultAPIURL = "https://app.daytona.io/api"
	apiTimeout    = 180 * time.Second // Creating sandbox with snapshot can take a while
)

// SandboxInfo represents a Daytona sandbox
type SandboxInfo struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Status string `json:"state"`
}

// SSHAccessResponse represents the response from the SSH access endpoint
type SSHAccessResponse struct {
	ID         string `json:"id"`
	SandboxID  string `json:"sandboxId"`
	Token      string `json:"token"`
	SSHCommand string `json:"sshCommand"`
	ExpiresAt  string `json:"expiresAt"`
}

// CreateSandboxRequest represents the request body for creating a sandbox
type CreateSandboxRequest struct {
	// Add fields as needed based on API requirements
	// For now, we'll create a basic sandbox with Docker support
}

// DaytonaClient wraps the Daytona REST API
type DaytonaClient struct {
	apiURL     string
	apiKey     string
	httpClient *http.Client
}

// NewDaytonaClient creates a new Daytona client using environment variables
// Required: DAYTONA_API_KEY
// Optional: DAYTONA_API_URL (defaults to https://api.daytona.io)
func NewDaytonaClient() (*DaytonaClient, error) {
	apiKey := os.Getenv("DAYTONA_API_KEY")
	if apiKey == "" {
		return nil, errors.New("DAYTONA_API_KEY environment variable is required")
	}

	apiURL := os.Getenv("DAYTONA_API_URL")
	if apiURL == "" {
		apiURL = defaultAPIURL
	}

	return &DaytonaClient{
		apiURL: apiURL,
		apiKey: apiKey,
		httpClient: &http.Client{
			Timeout: apiTimeout,
		},
	}, nil
}

// NewDaytonaClientWithConfig creates a client with explicit configuration
func NewDaytonaClientWithConfig(apiURL, apiKey string) *DaytonaClient {
	if apiURL == "" {
		apiURL = defaultAPIURL
	}
	return &DaytonaClient{
		apiURL: apiURL,
		apiKey: apiKey,
		httpClient: &http.Client{
			Timeout: apiTimeout,
		},
	}
}

func (d *DaytonaClient) doRequest(ctx context.Context, method, path string, body interface{}) ([]byte, error) {
	var bodyReader io.Reader
	if body != nil {
		jsonBody, err := json.Marshal(body)
		if err != nil {
			return nil, errors.Errorf("failed to marshal request body: %w", err)
		}
		bodyReader = bytes.NewReader(jsonBody)
	}

	url := d.apiURL + path
	req, err := http.NewRequestWithContext(ctx, method, url, bodyReader)
	if err != nil {
		return nil, errors.Errorf("failed to create request: %w", err)
	}

	req.Header.Set("Authorization", "Bearer "+d.apiKey)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")

	resp, err := d.httpClient.Do(req)
	if err != nil {
		return nil, errors.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, errors.Errorf("failed to read response: %w", err)
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, errors.Errorf("API error (status %d): %s", resp.StatusCode, string(respBody))
	}

	return respBody, nil
}

// Create creates a new Daytona sandbox with Docker support
// Auto-stop is disabled so the VM stays running while the session is active
func (d *DaytonaClient) Create(ctx context.Context) (*SandboxInfo, error) {
	reqBody := map[string]interface{}{
		"snapshot":            "supabase-remote-v4",
		"autoStopInterval":    1,  // Stop 1m after SSH disconnects
		"autoArchiveInterval": 10, // Archive after 10m
		"autoDeleteInterval":  30, // Delete after 30m
	}

	respBody, err := d.doRequest(ctx, http.MethodPost, "/sandbox", reqBody)
	if err != nil {
		return nil, err
	}

	// Debug: print response
	fmt.Printf("DEBUG Create response: %s\n", string(respBody))

	var sandbox SandboxInfo
	if err := json.Unmarshal(respBody, &sandbox); err != nil {
		return nil, errors.Errorf("failed to parse sandbox response: %w", err)
	}

	return &sandbox, nil
}

// GetSSHAccess gets SSH access credentials for a sandbox
func (d *DaytonaClient) GetSSHAccess(ctx context.Context, sandboxID string) (*SSHConfig, error) {
	path := fmt.Sprintf("/sandbox/%s/ssh-access?expiresInMinutes=120", sandboxID)

	respBody, err := d.doRequest(ctx, http.MethodPost, path, nil)
	if err != nil {
		return nil, err
	}

	var sshAccess SSHAccessResponse
	if err := json.Unmarshal(respBody, &sshAccess); err != nil {
		return nil, errors.Errorf("failed to parse SSH access response: %w", err)
	}

	// Daytona uses token-based SSH auth
	// sshCommand format: "ssh TOKEN@ssh.app.daytona.io"
	return &SSHConfig{
		Host:     "ssh.app.daytona.io",
		Port:     22,
		Username: sshAccess.Token,
		// No private key - Daytona uses token as username with no password
		PrivateKey: "",
	}, nil
}

// Destroy destroys a Daytona sandbox
func (d *DaytonaClient) Destroy(ctx context.Context, sandboxID string) error {
	path := fmt.Sprintf("/sandbox/%s", sandboxID)
	_, err := d.doRequest(ctx, http.MethodDelete, path, nil)
	return err
}

// Status gets the status of a Daytona sandbox
func (d *DaytonaClient) Status(ctx context.Context, sandboxID string) (*SandboxInfo, error) {
	path := fmt.Sprintf("/sandbox/%s", sandboxID)

	respBody, err := d.doRequest(ctx, http.MethodGet, path, nil)
	if err != nil {
		return nil, err
	}

	var sandbox SandboxInfo
	if err := json.Unmarshal(respBody, &sandbox); err != nil {
		return nil, errors.Errorf("failed to parse sandbox response: %w", err)
	}

	return &sandbox, nil
}

// Start starts a stopped sandbox
func (d *DaytonaClient) Start(ctx context.Context, sandboxID string) error {
	path := fmt.Sprintf("/sandbox/%s/start", sandboxID)
	_, err := d.doRequest(ctx, http.MethodPost, path, nil)
	return err
}

// Stop stops a running sandbox
func (d *DaytonaClient) Stop(ctx context.Context, sandboxID string) error {
	path := fmt.Sprintf("/sandbox/%s/stop", sandboxID)
	_, err := d.doRequest(ctx, http.MethodPost, path, nil)
	return err
}

// RefreshActivity updates the sandbox's last activity timestamp to prevent auto-stop.
// SSH connections alone do NOT count as activity - we must call this API periodically.
func (d *DaytonaClient) RefreshActivity(ctx context.Context, sandboxID string) error {
	path := fmt.Sprintf("/sandbox/%s/keepalive", sandboxID)
	_, err := d.doRequest(ctx, http.MethodPost, path, nil)
	return err
}

