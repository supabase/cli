package credentials

import (
	"bytes"
	"os"
	"os/exec"

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
	if errors.Is(err, exec.ErrNotFound) {
		return "", errors.New(ErrNotSupported)
	} else if err != nil {
		return "", errors.Errorf("failed to load credentials: %w", err)
	}
	return val, nil
}

// Stores the password of a project and username
func Set(project, password string) error {
	if err := assertKeyringSupported(); err != nil {
		return err
	}
	if err := keyring.Set(namespace, project, password); errors.Is(err, exec.ErrNotFound) {
		return errors.New(ErrNotSupported)
	} else if err != nil {
		return errors.Errorf("failed to set credentials: %w", err)
	}
	return nil
}

// Erases the stored password of a project and username
func Delete(project string) error {
	if err := assertKeyringSupported(); err != nil {
		return err
	}
	if err := keyring.Delete(namespace, project); errors.Is(err, exec.ErrNotFound) {
		return errors.New(ErrNotSupported)
	} else if err != nil {
		return errors.Errorf("failed to delete credentials: %w", err)
	}
	return nil
}

// Deletes all stored credentials for the namespace
func DeleteAll() error {
	return deleteAll(namespace)
}

func assertKeyringSupported() error {
	// Suggested check: https://github.com/microsoft/WSL/issues/423
	if f, err := os.ReadFile("/proc/sys/kernel/osrelease"); err == nil {
		if bytes.Contains(f, []byte("WSL")) || bytes.Contains(f, []byte("Microsoft")) {
			return errors.New(ErrNotSupported)
		}
	}
	return nil
}
