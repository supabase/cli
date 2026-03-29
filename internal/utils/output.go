package utils

import (
	"encoding/json"
	"fmt"
	"io"
	"strings"

	"github.com/BurntSushi/toml"
	"github.com/charmbracelet/glamour"
	"github.com/charmbracelet/glamour/styles"
	"github.com/go-errors/errors"
	"github.com/go-viper/mapstructure/v2"
	"github.com/joho/godotenv"
	"github.com/spf13/viper"
	"gopkg.in/yaml.v3"
)

const (
	OutputEnv    = "env"
	OutputJson   = "json"
	OutputPretty = "pretty"
	OutputToml   = "toml"
	OutputYaml   = "yaml"

	// OutputMetadata is used with certain SSO commands only.
	OutputMetadata = "metadata"
)

var OutputFormat = EnumFlag{
	Allowed: []string{
		OutputEnv,
		OutputPretty,
		OutputJson,
		OutputToml,
		OutputYaml,
	},
	Value: OutputPretty,
}

var ErrEnvNotSupported = errors.New("--output env flag is not supported")

func EncodeOutput(format string, w io.Writer, value any) error {
	switch format {
	case OutputEnv:
		mapvalue, err := ToEnvMap(value)
		if err != nil {
			return err
		}

		out, err := godotenv.Marshal(mapvalue)
		if err != nil {
			return errors.Errorf("failed to marshal env map: %w", err)
		}

		if _, err := fmt.Fprintln(w, out); err != nil {
			return errors.Errorf("failed to write encoded output: %w", err)
		}

	case OutputJson:
		enc := json.NewEncoder(w)
		enc.SetIndent("", "  ")

		if err := enc.Encode(value); err != nil {
			return errors.Errorf("failed to output json: %w", err)
		}

	case OutputYaml:
		enc := yaml.NewEncoder(w)
		if err := enc.Encode(value); err != nil {
			return errors.Errorf("failed to output yaml: %w", err)
		}

	case OutputToml:
		enc := toml.NewEncoder(w)
		if err := enc.Encode(value); err != nil {
			return errors.Errorf("failed to output toml: %w", err)
		}

	default:
		return errors.Errorf("Unsupported output encoding %q", format)
	}
	return nil
}

func ToEnvMap(value any) (map[string]string, error) {
	var result map[string]any
	if dec, err := mapstructure.NewDecoder(&mapstructure.DecoderConfig{
		TagName: "json",
		Result:  &result,
	}); err != nil {
		return nil, errors.Errorf("failed to init decoder: %w", err)
	} else if err := dec.Decode(value); err != nil {
		return nil, errors.Errorf("failed to decode env: %w", err)
	}
	v := viper.New()
	if err := v.MergeConfigMap(result); err != nil {
		return nil, errors.Errorf("failed to merge env: %w", err)
	}
	keys := v.AllKeys()
	mapvalue := make(map[string]string, len(keys))
	for _, k := range keys {
		name := strings.ToUpper(strings.ReplaceAll(k, ".", "_"))
		mapvalue[name] = v.GetString(k)
	}
	return mapvalue, nil
}

func RenderTable(markdown string) error {
	r, err := glamour.NewTermRenderer(
		glamour.WithStandardStyle(styles.AsciiStyle),
		glamour.WithWordWrap(-1),
	)
	if err != nil {
		return errors.Errorf("failed to initialise terminal renderer: %w", err)
	}
	out, err := r.Render(markdown)
	if err != nil {
		return errors.Errorf("failed to render markdown: %w", err)
	}
	fmt.Print(out)
	return nil
}
