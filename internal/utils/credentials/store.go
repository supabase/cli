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

type Store interface {
	Get(key string) (string, error)
	Set(key, value string) error
	Delete(project string) error
	DeleteAll() error
}

type KeyringStore struct{}

var StoreProvider Store = &KeyringStore{}

// Get retrieves the password for a project from the keyring.
func (ks *KeyringStore) Get(project string) (string, error) {
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

func (ks *KeyringStore) Set(project, password string) error {
	if err := assertKeyringSupported(); err != nil {
		return err
	}
	if err := keyring.Set(namespace, project, password); err != nil {
		if errors.Is(err, exec.ErrNotFound) {
			return ErrNotSupported
		}
		return errors.Errorf("failed to set credentials: %w", err)
	}
	return nil
}

func (ks *KeyringStore) Delete(project string) error {
	if err := assertKeyringSupported(); err != nil {
		return err
	}
	if err := keyring.Delete(namespace, project); err != nil {
		if errors.Is(err, exec.ErrNotFound) {
			return ErrNotSupported
		}
		return errors.Errorf("failed to delete credentials: %w", err)
	}
	return nil
}

func (ks *KeyringStore) DeleteAll() error {
	if err := assertKeyringSupported(); err != nil {
		return err
	}
	if err := keyring.DeleteAll(namespace); err != nil {
		if errors.Is(err, exec.ErrNotFound) {
			return ErrNotSupported
		}
		return errors.Errorf("failed to delete all credentials in %s: %w", namespace, err)
	}
	return nil
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
