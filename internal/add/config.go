package add

import (
	"fmt"
	"os"
	"regexp"
	"strings"

	"github.com/go-errors/errors"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
)

const (
	sectionFunctionsPrefix = "functions."
	sectionEdgeSecrets     = "edge_runtime.secrets"
	sectionDbVault         = "db.vault"
)

type configEditor struct {
	data    []byte
	changed bool
}

func loadConfigEditor(fsys afero.Fs) (*configEditor, error) {
	data, err := afero.ReadFile(fsys, utils.ConfigPath)
	if errors.Is(err, os.ErrNotExist) {
		if err := utils.WriteConfig(fsys, false); err != nil {
			return nil, err
		}
		data, err = afero.ReadFile(fsys, utils.ConfigPath)
	}
	if err != nil {
		return nil, errors.Errorf("failed to read config: %w", err)
	}
	return &configEditor{data: data}, nil
}

func (e *configEditor) save(fsys afero.Fs) error {
	if !e.changed {
		return nil
	}
	return utils.WriteFile(utils.ConfigPath, e.data, fsys)
}

func (e *configEditor) ensureFunctionConfig(slug string) {
	section := sectionFunctionsPrefix + slug
	e.ensureKV(section, "enabled", "true", false)
	e.ensureKV(section, "verify_jwt", "true", false)
	e.ensureKV(section, "import_map", "./functions/"+slug+"/deno.json", true)
	e.ensureKV(section, "entrypoint", "./functions/"+slug+"/index.ts", true)
}

func (e *configEditor) ensureSecretConfig(section, key string) {
	e.ensureKV(section, key, fmt.Sprintf("env(%s)", key), true)
}

func (e *configEditor) ensureKV(section, key, value string, quoted bool) {
	valueExpr := value
	if quoted {
		valueExpr = fmt.Sprintf("%q", value)
	}
	line := fmt.Sprintf("%s = %s\n", key, valueExpr)
	inserted := e.insertKVLine(section, key, line)
	e.changed = e.changed || inserted
}

func (e *configEditor) insertKVLine(section, key, line string) bool {
	start, end, found := findSectionBounds(string(e.data), section)
	if !found {
		return e.appendSection(section, line)
	}
	sectionBody := string(e.data[start:end])
	keyExpr := regexp.MustCompile(`(?m)^\s*` + regexp.QuoteMeta(key) + `\s*=`)
	if keyExpr.FindStringIndex(sectionBody) != nil {
		return false
	}
	insert := line
	if len(sectionBody) > 0 && !strings.HasSuffix(sectionBody, "\n") {
		insert = "\n" + insert
	}
	updated := append([]byte{}, e.data[:end]...)
	updated = append(updated, []byte(insert)...)
	updated = append(updated, e.data[end:]...)
	e.data = updated
	return true
}

func (e *configEditor) appendSection(section, content string) bool {
	body := string(e.data)
	if !strings.HasSuffix(body, "\n") {
		body += "\n"
	}
	body += fmt.Sprintf("\n[%s]\n%s", section, content)
	e.data = []byte(body)
	return true
}

func findSectionBounds(data, section string) (int, int, bool) {
	header := regexp.MustCompile(`(?m)^\[` + regexp.QuoteMeta(section) + `\]\s*$`)
	loc := header.FindStringIndex(data)
	if loc == nil {
		return 0, 0, false
	}
	afterHeader := loc[1]
	nextHeader := regexp.MustCompile(`(?m)^\[[^\]]+\]\s*$`)
	next := nextHeader.FindStringIndex(data[afterHeader:])
	if next == nil {
		return afterHeader, len(data), true
	}
	return afterHeader, afterHeader + next[0], true
}
