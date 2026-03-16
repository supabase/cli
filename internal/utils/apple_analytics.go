package utils

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/go-errors/errors"
	"github.com/spf13/afero"
)

const (
	appleAnalyticsStateDirName = "apple-analytics"
	appleAnalyticsLogsDirName  = "logs"
	appleAnalyticsPidsDirName  = "pids"
)

var (
	resolveAppleAnalyticsStateDir = func() (string, error) {
		return filepath.Abs(filepath.Join(TempDir, appleAnalyticsStateDirName))
	}
	startAppleAnalyticsForwarderProcess = func(containerID, outputPath string) (int, error) {
		executable, err := os.Executable()
		if err != nil {
			return 0, errors.Errorf("failed to resolve executable: %w", err)
		}
		devNull, err := os.OpenFile(os.DevNull, os.O_WRONLY, 0)
		if err != nil {
			return 0, errors.Errorf("failed to open null device: %w", err)
		}
		defer devNull.Close()
		cmd := exec.Command(executable, "apple-log-forwarder", "--container", containerID, "--output", outputPath)
		cmd.Stdout = devNull
		cmd.Stderr = devNull
		if err := cmd.Start(); err != nil {
			return 0, errors.Errorf("failed to start apple analytics forwarder: %w", err)
		}
		return cmd.Process.Pid, nil
	}
	interruptAppleAnalyticsForwarderProcess = func(pid int) error {
		process, err := os.FindProcess(pid)
		if err != nil {
			return err
		}
		return process.Signal(os.Interrupt)
	}
)

type appleAnalyticsLogEvent struct {
	Timestamp     string `json:"timestamp"`
	Message       string `json:"message"`
	ContainerName string `json:"container_name"`
	Stream        string `json:"stream"`
}

type appleAnalyticsLogWriter struct {
	mu sync.Mutex
	w  io.Writer
}

func AppleAnalyticsSourceContainers() []string {
	return []string{
		DbId,
		GotrueId,
		RestId,
		RealtimeId,
		StorageId,
		EdgeRuntimeId,
		KongId,
	}
}

func AppleAnalyticsLogsDirPath() (string, error) {
	stateDir, err := resolveAppleAnalyticsStateDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(stateDir, appleAnalyticsLogsDirName), nil
}

func StartAppleAnalyticsForwarders(containerIDs []string) error {
	if len(containerIDs) == 0 {
		return nil
	}
	stateDir, err := resolveAppleAnalyticsStateDir()
	if err != nil {
		return err
	}
	logDir := filepath.Join(stateDir, appleAnalyticsLogsDirName)
	pidDir := filepath.Join(stateDir, appleAnalyticsPidsDirName)
	if err := os.RemoveAll(stateDir); err != nil && !errors.Is(err, os.ErrNotExist) {
		return errors.Errorf("failed to reset apple analytics state: %w", err)
	}
	if err := os.MkdirAll(logDir, 0755); err != nil {
		return errors.Errorf("failed to create apple analytics log dir: %w", err)
	}
	if err := os.MkdirAll(pidDir, 0755); err != nil {
		return errors.Errorf("failed to create apple analytics pid dir: %w", err)
	}
	for _, containerID := range containerIDs {
		outputPath := filepath.Join(logDir, containerID+".jsonl")
		pid, err := startAppleAnalyticsForwarderProcess(containerID, outputPath)
		if err != nil {
			return err
		}
		pidPath := filepath.Join(pidDir, containerID+".pid")
		if err := os.WriteFile(pidPath, []byte(strconv.Itoa(pid)), 0644); err != nil {
			return errors.Errorf("failed to write apple analytics pid: %w", err)
		}
	}
	return nil
}

func StopAppleAnalyticsForwarders(fsys afero.Fs) error {
	stateDir, err := resolveAppleAnalyticsStateDir()
	if err != nil {
		return err
	}
	pidDir := filepath.Join(stateDir, appleAnalyticsPidsDirName)
	entries, err := afero.ReadDir(fsys, pidDir)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return errors.Errorf("failed to read apple analytics pid dir: %w", err)
	}
	var allErrors []error
	for _, entry := range entries {
		pidPath := filepath.Join(pidDir, entry.Name())
		pidBytes, err := afero.ReadFile(fsys, pidPath)
		if err != nil {
			allErrors = append(allErrors, errors.Errorf("failed to read apple analytics pid: %w", err))
			continue
		}
		pid, err := strconv.Atoi(strings.TrimSpace(string(pidBytes)))
		if err != nil {
			allErrors = append(allErrors, errors.Errorf("failed to parse apple analytics pid: %w", err))
			continue
		}
		if err := interruptAppleAnalyticsForwarderProcess(pid); err != nil && !errors.Is(err, os.ErrProcessDone) {
			allErrors = append(allErrors, errors.Errorf("failed to stop apple analytics forwarder: %w", err))
		}
	}
	if err := fsys.RemoveAll(stateDir); err != nil && !errors.Is(err, os.ErrNotExist) {
		allErrors = append(allErrors, errors.Errorf("failed to remove apple analytics state: %w", err))
	}
	return errors.Join(allErrors...)
}

func RunAppleAnalyticsLogForwarder(ctx context.Context, containerID, outputPath string) error {
	if err := os.MkdirAll(filepath.Dir(outputPath), 0755); err != nil {
		return errors.Errorf("failed to create apple analytics output dir: %w", err)
	}
	output, err := os.OpenFile(outputPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0644)
	if err != nil {
		return errors.Errorf("failed to open apple analytics output: %w", err)
	}
	defer output.Close()

	cmd := execContainerCommand(ctx, "container", "logs", "--follow", containerID)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return errors.Errorf("failed to capture apple analytics stdout: %w", err)
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return errors.Errorf("failed to capture apple analytics stderr: %w", err)
	}
	if err := cmd.Start(); err != nil {
		return wrapAppleContainerError(err, nil)
	}

	writer := &appleAnalyticsLogWriter{w: output}
	streamErrCh := make(chan error, 2)
	go func() {
		streamErrCh <- streamAppleAnalyticsLogs(stdout, writer, containerID, "stdout")
	}()
	go func() {
		streamErrCh <- streamAppleAnalyticsLogs(stderr, writer, containerID, "stderr")
	}()
	firstErr := <-streamErrCh
	secondErr := <-streamErrCh
	// Wait() closes the pipes it created, so let both readers drain first.
	waitErr := cmd.Wait()
	if errors.Is(ctx.Err(), context.Canceled) {
		return nil
	}
	if firstErr != nil {
		return firstErr
	}
	if secondErr != nil {
		return secondErr
	}
	if waitErr != nil {
		return wrapAppleContainerError(waitErr, nil)
	}
	return nil
}

func streamAppleAnalyticsLogs(r io.Reader, writer *appleAnalyticsLogWriter, containerID, stream string) error {
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		line := scanner.Text()
		if len(strings.TrimSpace(line)) == 0 {
			continue
		}
		if err := writer.writeEvent(appleAnalyticsLogEvent{
			Timestamp:     time.Now().UTC().Format(time.RFC3339Nano),
			Message:       line,
			ContainerName: containerID,
			Stream:        stream,
		}); err != nil {
			return err
		}
	}
	if err := scanner.Err(); err != nil && !errors.Is(err, io.EOF) {
		return errors.Errorf("failed to stream apple analytics logs: %w", err)
	}
	return nil
}

func (w *appleAnalyticsLogWriter) writeEvent(event appleAnalyticsLogEvent) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	data, err := json.Marshal(event)
	if err != nil {
		return errors.Errorf("failed to encode apple analytics log: %w", err)
	}
	if _, err := w.w.Write(append(data, '\n')); err != nil {
		return errors.Errorf("failed to write apple analytics log: %w", err)
	}
	return nil
}
