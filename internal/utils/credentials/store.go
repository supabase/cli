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
	Get(project string) (string, error)
	Set(project, password string) error
	Delete(project string) error
	DeleteAll() error
	assertKeyringSupported() error
}

type KeyringStore struct{}

var storeProvider Store = &KeyringStore{}

// Get retrieves the password for a project from the keyring.
func (provider *KeyringStore) Get(project string) (string, error) {
	if err := provider.assertKeyringSupported(); err != nil {
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

func Get(project string) (string, error) {
	return storeProvider.Get(project)
}

func (ks *KeyringStore) Set(project, password string) error {
	if err := ks.assertKeyringSupported(); err != nil {
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

func Set(project, password string) error {
	return storeProvider.Set(project, password)
}

func (ks *KeyringStore) Delete(project string) error {
	if err := ks.assertKeyringSupported(); err != nil {
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

func Delete(project string) error {
	return storeProvider.Delete(project)
}

func (ks *KeyringStore) DeleteAll() error {
	return deleteAll(namespace)
}

func DeleteAll() error {
	return storeProvider.DeleteAll()
}

func (ks *KeyringStore) assertKeyringSupported() error {
	// Suggested check: https://github.com/microsoft/WSL/issues/423
	if f, err := os.ReadFile("/proc/sys/kernel/osrelease"); err == nil {
		if bytes.Contains(f, []byte("WSL")) || bytes.Contains(f, []byte("Microsoft")) {
			return errors.New(ErrNotSupported)
		}
	}
	return nil
}
