package add

import (
	"encoding/json"
	"strings"
)

type Template struct {
	Name        string                   `json:"name"`
	Title       string                   `json:"title"`
	Description string                   `json:"description"`
	Version     string                   `json:"version"`
	Inputs      map[string]TemplateInput `json:"inputs"`
	Steps       []TemplateStep           `json:"steps"`
	PostInstall *TemplatePostInstall     `json:"postInstall"`
}

type TemplatePostInstall struct {
	Title   string `json:"title"`
	Message string `json:"message"`
}

type TemplateInput struct {
	Label       string      `json:"label"`
	Type        string      `json:"type"`
	Required    bool        `json:"required"`
	Default     interface{} `json:"default"`
	Options     []string    `json:"options"`
	Description string      `json:"description"`
}

type TemplateStep struct {
	Name        string              `json:"name"`
	Title       string              `json:"title"`
	Description string              `json:"description"`
	Components  []TemplateComponent `json:"components"`
}

type TemplateComponent struct {
	Name   string            `json:"name"`
	Type   string            `json:"type"`
	Path   TemplatePath      `json:"path"`
	Key    string            `json:"key"`
	Value  string            `json:"value"`
	Schema string            `json:"schema"`
	Output map[string]string `json:"output"`
}

type TemplatePath []string

func (p *TemplatePath) UnmarshalJSON(data []byte) error {
	var single string
	if err := json.Unmarshal(data, &single); err == nil {
		single = strings.TrimSpace(single)
		if len(single) == 0 {
			*p = nil
		} else {
			*p = []string{single}
		}
		return nil
	}
	var multi []string
	if err := json.Unmarshal(data, &multi); err != nil {
		return err
	}
	out := make([]string, 0, len(multi))
	for _, raw := range multi {
		raw = strings.TrimSpace(raw)
		if len(raw) > 0 {
			out = append(out, raw)
		}
	}
	*p = out
	return nil
}
