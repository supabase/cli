package fstest

import (
	"io/fs"
	"os"
	"strings"

	"github.com/spf13/afero"
)

type OpenErrorFs struct {
	afero.MemMapFs
	DenyPath string
}

func (m *OpenErrorFs) OpenFile(name string, flag int, perm os.FileMode) (afero.File, error) {
	if strings.HasPrefix(name, m.DenyPath) {
		return nil, fs.ErrPermission
	}
	return m.MemMapFs.OpenFile(name, flag, perm)
}

func (m *OpenErrorFs) Open(name string) (afero.File, error) {
	if strings.HasPrefix(name, m.DenyPath) {
		return nil, fs.ErrPermission
	}
	return m.MemMapFs.Open(name)
}
