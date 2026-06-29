package telemetry

import (
	"encoding/json"
	"os"
	"path/filepath"
	"time"

	"github.com/go-errors/errors"
	"github.com/google/uuid"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
)

const SchemaVersion = 1

const sessionRotationThreshold = 30 * time.Minute

// errMalformedState marks any read where the file existed but couldn't be
// decoded into a State — covers JSON syntax errors, unexpected types
// (e.g. session_last_active stored as a number), and field-level unmarshal
// failures from time.Time / uuid. Used to trigger fresh-state creation.
var errMalformedState = errors.New("malformed telemetry state")

type State struct {
	Enabled           bool      `json:"enabled"`
	DeviceID          string    `json:"device_id"`
	SessionID         string    `json:"session_id"`
	SessionLastActive time.Time `json:"session_last_active"`
	DistinctID        string    `json:"distinct_id,omitempty"`
	SchemaVersion     int       `json:"schema_version"`
}

type rawState struct {
	Enabled           *bool           `json:"enabled"`
	Consent           *string         `json:"consent"`
	DeviceID          string          `json:"device_id"`
	SessionID         string          `json:"session_id"`
	SessionLastActive json.RawMessage `json:"session_last_active"`
	DistinctID        string          `json:"distinct_id,omitempty"`
	SchemaVersion     int             `json:"schema_version"`
}

func telemetryPath() (string, error) {
	home, err := utils.SupabaseHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, "telemetry.json"), nil
}

func parseConsent(raw rawState) (bool, bool, error) {
	if raw.Consent != nil {
		switch *raw.Consent {
		case "granted":
			return true, true, nil
		case "denied":
			return false, true, nil
		default:
			return false, false, errors.Errorf("%w: invalid consent", errMalformedState)
		}
	}
	if raw.Enabled == nil {
		return false, false, errors.Errorf("%w: missing enabled", errMalformedState)
	}
	return *raw.Enabled, false, nil
}

func parseSessionLastActive(raw json.RawMessage, allowUnixMillis bool) (time.Time, error) {
	var text string
	if err := json.Unmarshal(raw, &text); err == nil {
		parsed, err := time.Parse(time.RFC3339Nano, text)
		if err != nil {
			return time.Time{}, errors.Errorf("%w: invalid session_last_active", errMalformedState)
		}
		return parsed, nil
	}
	if allowUnixMillis {
		var millis int64
		if err := json.Unmarshal(raw, &millis); err == nil {
			return time.UnixMilli(millis).UTC(), nil
		}
	}
	return time.Time{}, errors.Errorf("%w: invalid session_last_active", errMalformedState)
}

func decodeState(contents []byte) (State, error) {
	var raw rawState
	if err := json.Unmarshal(contents, &raw); err != nil {
		return State{}, errors.Errorf("%w: %v", errMalformedState, err)
	}
	enabled, allowUnixMillis, err := parseConsent(raw)
	if err != nil {
		return State{}, err
	}
	sessionLastActive, err := parseSessionLastActive(raw.SessionLastActive, allowUnixMillis)
	if err != nil {
		return State{}, err
	}
	if raw.DeviceID == "" || raw.SessionID == "" {
		return State{}, errors.Errorf("%w: missing identity", errMalformedState)
	}
	schemaVersion := raw.SchemaVersion
	if schemaVersion == 0 {
		schemaVersion = SchemaVersion
	}
	return State{
		Enabled:           enabled,
		DeviceID:          raw.DeviceID,
		SessionID:         raw.SessionID,
		SessionLastActive: sessionLastActive,
		DistinctID:        raw.DistinctID,
		SchemaVersion:     schemaVersion,
	}, nil
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
	return decodeState(contents)
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
		if now.UTC().Sub(state.SessionLastActive) > sessionRotationThreshold {
			state.SessionID = uuid.NewString()
		}
		state.SessionLastActive = now.UTC()
		return state, false, SaveState(state, fsys)
	}
	// Treat a missing file OR an unparseable file as "no existing state" and
	// recreate. Identity fields (device_id, session_id) are not worth
	// surfacing an error for — losing them is harmless. We only propagate
	// genuine I/O errors (permissions, disk full) so the user can act.
	if !errors.Is(err, os.ErrNotExist) && !errors.Is(err, errMalformedState) {
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
