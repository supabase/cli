package credentials

import (
	"bytes"
	"os"

	"github.com/go-errors/errors"
	"github.com/zalando/go-keyring"
)

const namespace = "Supabase CLI"

var ErrNotSupported = errors.New("Keyring is not supported on WSL")

// Retrieves the stored password of a project and username
func Get(project string) (string, error) {
	if err := assertKeyringSupported(); err != nil {
		return "", err
	}
	val, err := keyring.Get(namespace, project)
	if err != nil {
		return "", errors.Errorf("failed to load credentials: %w", err)
	}
	return val, nil
}

// Stores the password of a project and username
func Set(project, password string) error {
	if err := assertKeyringSupported(); err != nil {
		return err
	}
	if err := keyring.Set(namespace, project, password); err != nil {
		return errors.Errorf("failed to set credentials: %w", err)
	}
	return nil
}

// Erases the stored password of a project and username
func Delete(project string) error {
	if err := assertKeyringSupported(); err != nil {
		return err
	}
	if err := keyring.Delete(namespace, project); err != nil {
		return errors.Errorf("failed to delete credentials: %w", err)
	}
	return nil
}

func assertKeyringSupported() error {
	// Suggested check: https://github.com/microsoft/WSL/issues/423
	if f, err := os.ReadFile("/proc/sys/kernel/osrelease"); err == nil && bytes.Contains(f, []byte("WSL")) {
		return errors.New(ErrNotSupported)
	}
	return nil
}
