package fstest

import (
	"io/fs"
	"strings"

	"github.com/spf13/afero"
)

type StatErrorFs struct {
	afero.MemMapFs
	DenyPath string
}

func (m *StatErrorFs) Stat(name string) (fs.FileInfo, error) {
	if strings.HasPrefix(name, m.DenyPath) {
		return nil, fs.ErrPermission
	}
	return m.MemMapFs.Stat(name)
}
