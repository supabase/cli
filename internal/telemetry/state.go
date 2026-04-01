package telemetry

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/go-errors/errors"
	"github.com/google/uuid"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
)

const SchemaVersion = 1

type State struct {
	Enabled           bool      `json:"enabled"`
	DeviceID          string    `json:"device_id"`
	SessionID         string    `json:"session_id"`
	SessionLastActive time.Time `json:"session_last_active"`
	DistinctID        string    `json:"distinct_id,omitempty"`
	SchemaVersion     int       `json:"schema_version"`
}

func telemetryPath() (string, error) {
	if home := strings.TrimSpace(os.Getenv("SUPABASE_HOME")); home != "" {
		return filepath.Join(home, "telemetry.json"), nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", errors.Errorf("failed to get $HOME directory: %w", err)
	}
	return filepath.Join(home, ".supabase", "telemetry.json"), nil
}

func LoadState(fsys afero.Fs) (State, error) {
	path, err := telemetryPath()
	if err != nil {
		return State{}, err
	}
	contents, err := afero.ReadFile(fsys, path)
	if err != nil {
		return State{}, err
	}
	var state State
	if err := json.Unmarshal(contents, &state); err != nil {
		return State{}, errors.Errorf("failed to parse telemetry file: %w", err)
	}
	return state, nil
}

func SaveState(state State, fsys afero.Fs) error {
	path, err := telemetryPath()
	if err != nil {
		return err
	}
	contents, err := json.Marshal(state)
	if err != nil {
		return errors.Errorf("failed to encode telemetry file: %w", err)
	}
	return utils.WriteFile(path, contents, fsys)
}

func LoadOrCreateState(fsys afero.Fs, now time.Time) (State, bool, error) {
	state, err := LoadState(fsys)
	if err == nil {
		state.SessionLastActive = now.UTC()
		return state, false, SaveState(state, fsys)
	}
	if !errors.Is(err, os.ErrNotExist) {
		return State{}, false, err
	}
	state = State{
		Enabled:           true,
		DeviceID:          uuid.NewString(),
		SessionID:         uuid.NewString(),
		SessionLastActive: now.UTC(),
		SchemaVersion:     SchemaVersion,
	}
	return state, true, SaveState(state, fsys)
}

func Disabled(fsys afero.Fs, now time.Time) (bool, error) {
	if os.Getenv("DO_NOT_TRACK") == "1" {
		return true, nil
	}
	if os.Getenv("SUPABASE_TELEMETRY_DISABLED") == "1" {
		return true, nil
	}
	state, _, err := LoadOrCreateState(fsys, now)
	if err != nil {
		return false, err
	}
	return !state.Enabled, nil
}

func SetEnabled(fsys afero.Fs, enabled bool, now time.Time) (State, error) {
	state, _, err := LoadOrCreateState(fsys, now)
	if err != nil {
		return State{}, err
	}
	state.Enabled = enabled
	return state, SaveState(state, fsys)
}

func Status(fsys afero.Fs, now time.Time) (State, bool, error) {
	return LoadOrCreateState(fsys, now)
}
