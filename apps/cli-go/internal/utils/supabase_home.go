package utils

import (
	"os"
	"path/filepath"
	"strings"

	"github.com/go-errors/errors"
)

// SupabaseHomeDir returns the global Supabase CLI state root. It is overridden
// by the SUPABASE_HOME environment variable when set to a non-empty value (an
// absolute path is expected; the value is used verbatim), otherwise it defaults
// to ~/.supabase.
func SupabaseHomeDir() (string, error) {
	if home := strings.TrimSpace(os.Getenv("SUPABASE_HOME")); home != "" {
		return home, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", errors.Errorf("failed to get $HOME directory: %w", err)
	}
	return filepath.Join(home, ".supabase"), nil
}
