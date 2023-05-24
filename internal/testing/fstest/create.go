package fstest

import (
	"io/fs"
	"strings"

	"github.com/spf13/afero"
)

type CreateErrorFs struct {
	afero.MemMapFs
	DenyPath string
}

func (m *CreateErrorFs) Create(name string) (afero.File, error) {
	if strings.HasPrefix(name, m.DenyPath) {
		return nil, fs.ErrPermission
	}
	return m.MemMapFs.Create(name)
}
