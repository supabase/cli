package credentials

import (
	"bytes"
	"errors"
	"os"

	"github.com/zalando/go-keyring"
)

const namespace = "Supabase CLI"

// Retrieves the stored password of a project and username
func Get(project string) (string, error) {
	if err := assertKeyringSupported(); err != nil {
		return "", err
	}
	return keyring.Get(namespace, project)
}

// Stores the password of a project and username
func Set(project, password string) error {
	if err := assertKeyringSupported(); err != nil {
		return err
	}
	return keyring.Set(namespace, project, password)
}

// Erases the stored password of a project and username
func Delete(project string) error {
	if err := assertKeyringSupported(); err != nil {
		return err
	}
	return keyring.Delete(namespace, project)
}

func assertKeyringSupported() error {
	// Suggested check: https://github.com/microsoft/WSL/issues/423
	if f, err := os.ReadFile("/proc/sys/kernel/osrelease"); err == nil && bytes.Contains(f, []byte("WSL")) {
		return errors.New("Keyring is not supported on WSL")
	}
	return nil
}
