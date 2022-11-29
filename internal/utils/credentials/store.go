package credentials

import (
	"github.com/zalando/go-keyring"
)

const namespace = "Supabase CLI"

// Retrieves the stored password of a project and username
func Get(project string) (string, error) {
	return keyring.Get(namespace, project)
}

// Stores the password of a project and username
func Set(project, password string) error {
	return keyring.Set(namespace, project, password)
}

// Erases the stored password of a project and username
func Delete(project string) error {
	return keyring.Delete(namespace, project)
}
