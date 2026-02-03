package sandbox

import (
	"bytes"
	_ "embed"
	"fmt"
	"text/template"

	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
)

//go:embed templates/nginx.conf.tmpl
var nginxConfigEmbed string
var nginxConfigTemplate = template.Must(template.New("nginxConfig").Parse(nginxConfigEmbed))

// nginxConfig holds the template variables for nginx.conf generation.
type nginxConfig struct {
	NginxPort          int
	GoTruePort         int
	PostgRESTPort      int
	PostgRESTAdminPort int
	ServiceRoleKey     string
	ServiceRoleJWT     string
	AnonKey            string
	AnonJWT            string
}

// GenerateNginxConfig generates the nginx configuration from the template.
func GenerateNginxConfig(ctx *SandboxContext) (string, error) {
	var buf bytes.Buffer

	data := nginxConfig{
		NginxPort:          ctx.Ports.Nginx,
		GoTruePort:         ctx.Ports.GoTrue,
		PostgRESTPort:      ctx.Ports.PostgREST,
		PostgRESTAdminPort: ctx.Ports.PostgRESTAdmin,
		ServiceRoleKey:     utils.Config.Auth.SecretKey.Value,
		ServiceRoleJWT:     utils.Config.Auth.ServiceRoleKey.Value,
		AnonKey:            utils.Config.Auth.PublishableKey.Value,
		AnonJWT:            utils.Config.Auth.AnonKey.Value,
	}

	if err := nginxConfigTemplate.Option("missingkey=error").Execute(&buf, data); err != nil {
		return "", fmt.Errorf("failed to execute nginx template: %w", err)
	}

	return buf.String(), nil
}

// WriteNginxConfig generates and writes nginx.conf to the project sandbox directory.
func WriteNginxConfig(ctx *SandboxContext, fsys afero.Fs) error {
	content, err := GenerateNginxConfig(ctx)
	if err != nil {
		return err
	}

	configPath := ctx.NginxConfigPath()
	if err := afero.WriteFile(fsys, configPath, []byte(content), 0644); err != nil {
		return fmt.Errorf("failed to write nginx config: %w", err)
	}

	return nil
}
