package sandbox

import (
	"bytes"
	"context"
	_ "embed"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"text/template"
	"time"

	"github.com/f1bonacc1/process-compose/src/api"
	"github.com/f1bonacc1/process-compose/src/app"
	"github.com/f1bonacc1/process-compose/src/loader"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
)

//go:embed templates/process-compose.yaml.tmpl
var processComposeTemplate string

// processComposeConfig holds the template variables for process-compose.yaml generation.
type processComposeConfig struct {
	LogLocation        string
	PostgresContainer  string
	PostgresPort       int
	DbPassword         string
	DbSchemas          string
	DbExtraSearchPath  string
	DbMaxRows          uint
	JwtSecret          string
	JwtExpiry          uint
	SiteUrl            string
	EmailEnabled       bool
	MailerAutoconfirm  bool
	NginxPort          int
	GoTruePort         int
	PostgRESTPort      int
	PostgRESTAdminPort int
	GotruePath         string
	PostgrestPath      string
	NginxPath          string
	NginxConfigPath    string
}

// GenerateProcessComposeConfig generates the process-compose.yaml from the template.
func GenerateProcessComposeConfig(ctx *SandboxContext) (string, error) {
	tmpl, err := template.New("process-compose").Parse(processComposeTemplate)
	if err != nil {
		return "", fmt.Errorf("failed to parse process-compose template: %w", err)
	}

	data := processComposeConfig{
		LogLocation:        filepath.Join(ctx.LogDir(), "process-compose.log"),
		PostgresContainer:  ctx.ContainerName("db"),
		PostgresPort:       ctx.Ports.Postgres,
		DbPassword:         utils.Config.Db.Password,
		DbSchemas:          strings.Join(utils.Config.Api.Schemas, ","),
		DbExtraSearchPath:  strings.Join(utils.Config.Api.ExtraSearchPath, ","),
		DbMaxRows:          utils.Config.Api.MaxRows,
		JwtSecret:          utils.Config.Auth.JwtSecret.Value,
		JwtExpiry:          utils.Config.Auth.JwtExpiry,
		SiteUrl:            utils.Config.Auth.SiteUrl,
		EmailEnabled:       utils.Config.Auth.Email.EnableSignup,
		MailerAutoconfirm:  !utils.Config.Auth.Email.EnableConfirmations,
		NginxPort:          ctx.Ports.Nginx,
		GoTruePort:         ctx.Ports.GoTrue,
		PostgRESTPort:      ctx.Ports.PostgREST,
		PostgRESTAdminPort: ctx.Ports.PostgRESTAdmin,
		GotruePath:         GetGotruePath(ctx.BinDir),
		PostgrestPath:      GetPostgrestPath(ctx.BinDir),
		NginxPath:          GetNginxPath(ctx.BinDir),
		NginxConfigPath:    ctx.NginxConfigPath(),
	}

	var buf bytes.Buffer
	if err := tmpl.Execute(&buf, data); err != nil {
		return "", fmt.Errorf("failed to execute process-compose template: %w", err)
	}

	return buf.String(), nil
}

// WriteProcessComposeConfig generates and writes process-compose.yaml to the sandbox directory.
func WriteProcessComposeConfig(ctx *SandboxContext, fsys afero.Fs) (string, error) {
	content, err := GenerateProcessComposeConfig(ctx)
	if err != nil {
		return "", err
	}

	configPath := filepath.Join(ctx.ConfigDir, "process-compose.yaml")
	if err := afero.WriteFile(fsys, configPath, []byte(content), 0644); err != nil {
		return "", fmt.Errorf("failed to write process-compose config: %w", err)
	}

	return configPath, nil
}

// RunProject starts all services using process-compose.
// If detach is true, it spawns a background server process, waits for health, then exits.
// If detach is false, it runs in foreground with signal handling.
func RunProject(configPath string, detach bool, sandboxCtx *SandboxContext, fsys afero.Fs) error {
	if detach {
		return runDetached(configPath, sandboxCtx, fsys)
	}
	return runAttached(configPath, sandboxCtx.Ports.ProcessCompose)
}

// runDetached spawns a background server process and waits for services to be healthy.
// The server process runs the HTTP API for graceful shutdown via 'supabase stop'.
func runDetached(configPath string, sandboxCtx *SandboxContext, fsys afero.Fs) error {
	// Spawn the server as a detached background process
	serverCmd := exec.Command(os.Args[0], "_sandbox-server",
		"--config", configPath,
		"--port", fmt.Sprintf("%d", sandboxCtx.Ports.ProcessCompose),
	)

	// Redirect output to log file
	logPath := filepath.Join(sandboxCtx.LogDir(), "server.log")
	logFile, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
	if err != nil {
		return fmt.Errorf("failed to create server log file: %w", err)
	}
	serverCmd.Stdout = logFile
	serverCmd.Stderr = logFile

	// Platform-specific detachment
	if runtime.GOOS != "windows" {
		serverCmd.SysProcAttr = &syscall.SysProcAttr{
			Setpgid: true, // Create new process group so it survives parent exit
		}
	}

	if err := serverCmd.Start(); err != nil {
		logFile.Close()
		return fmt.Errorf("failed to start server process: %w", err)
	}
	logFile.Close()

	// Save server PID for fallback shutdown
	pids := &ProcessPids{
		Nginx:     0, // Will be populated by server
		GoTrue:    0,
		PostgREST: 0,
	}
	// Store server PID in a special field - we'll use it if HTTP API fails
	if err := sandboxCtx.SavePids(fsys, pids); err != nil {
		fmt.Fprintf(os.Stderr, "Warning: failed to save PIDs: %v\n", err)
	}

	// Wait for all services to be healthy via HTTP API
	fmt.Fprintln(os.Stderr, "Waiting for services to be healthy...")
	if err := WaitForServerReady(sandboxCtx.Ports.ProcessCompose, 120*time.Second); err != nil {
		// Try to kill the server process
		if serverCmd.Process != nil {
			_ = serverCmd.Process.Kill()
		}
		return err
	}

	fmt.Fprintln(os.Stderr, "\nAll services are running.")
	fmt.Fprintln(os.Stderr, "Use 'supabase stop' to stop the sandbox.")

	return nil
}

// runAttached runs the server in foreground with signal handling.
func runAttached(configPath string, serverPort int) error {
	// Load process-compose config
	loaderOpts := &loader.LoaderOptions{
		FileNames: []string{configPath},
	}

	project, err := loader.Load(loaderOpts)
	if err != nil {
		return fmt.Errorf("failed to load process-compose config: %w", err)
	}

	opts := &app.ProjectOpts{}
	opts.WithProject(project).WithIsTuiOn(false)

	runner, err := app.NewProjectRunner(opts)
	if err != nil {
		return fmt.Errorf("failed to create project runner: %w", err)
	}

	// Start HTTP server for remote control
	server, err := api.StartHttpServerWithTCP(false, "127.0.0.1", serverPort, runner)
	if err != nil {
		return fmt.Errorf("failed to start process-compose server on port %d: %w", serverPort, err)
	}

	// Set up signal handling
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)

	// Channel to receive runner errors
	errChan := make(chan error, 1)

	// Start the runner in a goroutine
	go func() {
		errChan <- runner.Run()
	}()

	// Wait for signal or runner exit
	select {
	case sig := <-sigChan:
		fmt.Fprintf(os.Stderr, "\nReceived %v, shutting down...\n", sig)
		if err := runner.ShutDownProject(); err != nil {
			fmt.Fprintf(os.Stderr, "Error during shutdown: %v\n", err)
		}
		runner.WaitForProjectShutdown()
		shutdownServer(server)
		return nil
	case err := <-errChan:
		shutdownServer(server)
		return err
	}
}

// shutdownServer gracefully shuts down the HTTP server.
func shutdownServer(server interface{ Shutdown(context.Context) error }) {
	if server == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := server.Shutdown(ctx); err != nil {
		fmt.Fprintf(os.Stderr, "Warning: server shutdown error: %v\n", err)
	}
}
