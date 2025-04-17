package function

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/go-errors/errors"
	"github.com/tidwall/jsonc"
)

type ImportMap struct {
	Imports map[string]string            `json:"imports"`
	Scopes  map[string]map[string]string `json:"scopes"`
	// Fallback reference for deno.json
	ImportMap string `json:"importMap"`
}

func (m *ImportMap) LoadAsDeno(imPath string, fsys fs.FS, opts ...func(string, io.Reader) error) error {
	if err := m.Load(imPath, fsys, opts...); err != nil {
		return err
	}
	if name := path.Base(imPath); isDeno(name) && m.IsReference() {
		imPath = path.Join(path.Dir(imPath), m.ImportMap)
		if err := m.Load(imPath, fsys, opts...); err != nil {
			return err
		}
	}
	return nil
}

func isDeno(name string) bool {
	return strings.EqualFold(name, "deno.json") ||
		strings.EqualFold(name, "deno.jsonc")
}

func (m *ImportMap) IsReference() bool {
	// Ref: https://github.com/denoland/deno/blob/main/cli/schemas/config-file.v1.json#L273
	return len(m.Imports) == 0 && len(m.Scopes) == 0 && len(m.ImportMap) > 0
}

func (m *ImportMap) Load(imPath string, fsys fs.FS, opts ...func(string, io.Reader) error) error {
	data, err := fs.ReadFile(fsys, filepath.FromSlash(imPath))
	if err != nil {
		return errors.Errorf("failed to load import map: %w", err)
	}
	if err := m.Parse(data); err != nil {
		return err
	}
	if err := m.Resolve(imPath, fsys); err != nil {
		return err
	}
	for _, apply := range opts {
		if err := apply(imPath, bytes.NewReader(data)); err != nil {
			return err
		}
	}
	return nil
}

func (m *ImportMap) Parse(data []byte) error {
	data = jsonc.ToJSONInPlace(data)
	decoder := json.NewDecoder(bytes.NewReader(data))
	if err := decoder.Decode(&m); err != nil {
		return errors.Errorf("failed to parse import map: %w", err)
	}
	return nil
}

func (m *ImportMap) Resolve(imPath string, fsys fs.FS) error {
	// Resolve all paths relative to current file
	for k, v := range m.Imports {
		m.Imports[k] = resolveHostPath(imPath, v, fsys)
	}
	for module, mapping := range m.Scopes {
		for k, v := range mapping {
			m.Scopes[module][k] = resolveHostPath(imPath, v, fsys)
		}
	}
	return nil
}

func resolveHostPath(jsonPath, hostPath string, fsys fs.FS) string {
	// Leave absolute paths unchanged
	if path.IsAbs(hostPath) {
		return hostPath
	}
	resolved := path.Join(path.Dir(jsonPath), hostPath)
	if _, err := fs.Stat(fsys, filepath.FromSlash(resolved)); err != nil {
		// Leave URLs unchanged
		return hostPath
	}
	// Directory imports need to be suffixed with /
	// Ref: https://deno.com/manual@v1.33.0/basics/import_maps
	if strings.HasSuffix(hostPath, "/") {
		resolved += "/"
	}
	// Relative imports must be prefixed with ./ or ../
	if !path.IsAbs(resolved) {
		resolved = "./" + resolved
	}
	return resolved
}

// Ref: https://regex101.com/r/DfBdJA/1
var importPathPattern = regexp.MustCompile(`(?i)(?:import|export)\s+(?:{[^{}]+}|.*?)\s*(?:from)?\s*['"](.*?)['"]|import\(\s*['"](.*?)['"]\)`)

func (importMap *ImportMap) WalkImportPaths(srcPath string, readFile func(curr string, w io.Writer) error) error {
	seen := map[string]struct{}{}
	// DFS because it's more efficient to pop from end of array
	q := make([]string, 1)
	q[0] = srcPath
	for len(q) > 0 {
		curr := q[len(q)-1]
		q = q[:len(q)-1]
		// Assume no file is symlinked
		if _, ok := seen[curr]; ok {
			continue
		}
		seen[curr] = struct{}{}
		// Read into memory for regex match later
		var buf bytes.Buffer
		if err := readFile(curr, &buf); errors.Is(err, os.ErrNotExist) {
			fmt.Fprintln(os.Stderr, "WARN:", err)
			continue
		} else if err != nil {
			return err
		}
		// Traverse all modules imported by the current source file
		for _, matches := range importPathPattern.FindAllStringSubmatch(buf.String(), -1) {
			if len(matches) < 3 {
				continue
			}
			// Matches 'from' clause if present, else fallback to 'import'
			mod := matches[1]
			if len(mod) == 0 {
				mod = matches[2]
			}
			mod = strings.TrimSpace(mod)
			// Substitute kv from import map
			substituted := false
			for k, v := range importMap.Imports {
				if strings.HasPrefix(mod, k) {
					mod = v + mod[len(k):]
					substituted = true
				}
			}
			// Ignore URLs and directories, assuming no sloppy imports
			// https://github.com/denoland/deno/issues/2506#issuecomment-2727635545
			if len(path.Ext(mod)) == 0 {
				continue
			}
			// Deno import path must begin with one of these prefixes
			if !isRelPath(mod) && !isAbsPath(mod) {
				continue
			}
			if isRelPath(mod) && !substituted {
				mod = path.Join(path.Dir(curr), mod)
			}
			// Cleans import path to help detect duplicates
			q = append(q, path.Clean(mod))
		}
	}
	return nil
}

func isRelPath(mod string) bool {
	return strings.HasPrefix(mod, "./") || strings.HasPrefix(mod, "../")
}

func isAbsPath(mod string) bool {
	return strings.HasPrefix(mod, "/")
}
