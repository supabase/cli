package add

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"github.com/go-errors/errors"
	"github.com/spf13/afero"
	"github.com/spf13/viper"
	"github.com/supabase/cli/internal/component/placement"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/credentials"
	"github.com/supabase/cli/internal/utils/flags"
)

type runtimeState struct {
	contextValues map[string]string
	refs          map[string]string
	config        *configEditor
	addedSql      []string
}

func Run(ctx context.Context, source string, inputArgs []string, fsys afero.Fs) error {
	if err := flags.LoadConfig(fsys); err != nil {
		return err
	}
	src, templateBody, err := newTemplateSource(ctx, source, fsys)
	if err != nil {
		return err
	}
	var tmpl Template
	if err := json.Unmarshal(templateBody, &tmpl); err != nil {
		return errors.Errorf("failed to parse template manifest: %w", err)
	}
	if len(tmpl.Name) == 0 {
		return errors.New("template manifest missing name")
	}
	overrides, err := parseInputArgs(inputArgs)
	if err != nil {
		return err
	}
	values, err := collectInputs(ctx, tmpl.Inputs, overrides)
	if err != nil {
		return err
	}
	editor, err := loadConfigEditor(fsys)
	if err != nil {
		return err
	}
	state := runtimeState{
		contextValues: values,
		refs:          map[string]string{},
		config:        editor,
	}
	fmt.Fprintln(os.Stderr, "Adding template:", tmpl.Name)
	for _, step := range tmpl.Steps {
		if len(step.Title) > 0 {
			fmt.Fprintln(os.Stderr, "Step:", step.Title)
		} else if len(step.Name) > 0 {
			fmt.Fprintln(os.Stderr, "Step:", step.Name)
		}
		for _, c := range step.Components {
			if err := executeComponent(ctx, src, c, fsys, &state); err != nil {
				return err
			}
		}
	}
	if len(state.addedSql) > 0 && len(utils.Config.Db.Migrations.SchemaPaths) == 0 {
		state.config.ensureDefaultSchemaPaths()
	}
	if err := state.config.save(fsys); err != nil {
		return err
	}
	fmt.Println("Finished " + utils.Aqua("supabase add") + ".")
	return nil
}

func parseInputArgs(pairs []string) (map[string]string, error) {
	result := make(map[string]string, len(pairs))
	for _, pair := range pairs {
		k, v, ok := strings.Cut(pair, "=")
		if !ok || len(strings.TrimSpace(k)) == 0 {
			return nil, errors.Errorf("invalid --input value %q, expected key=value", pair)
		}
		result[strings.TrimSpace(k)] = strings.TrimSpace(v)
	}
	return result, nil
}

func collectInputs(ctx context.Context, inputs map[string]TemplateInput, overrides map[string]string) (map[string]string, error) {
	result := make(map[string]string, len(inputs))
	if len(inputs) == 0 {
		return result, nil
	}
	keys := make([]string, 0, len(inputs))
	for key := range inputs {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	console := utils.NewConsole()
	for _, key := range keys {
		spec := inputs[key]
		value, err := resolveInputValue(ctx, console, key, spec, overrides[key])
		if err != nil {
			return nil, err
		}
		result[key] = value
	}
	return result, nil
}

func resolveInputValue(ctx context.Context, console *utils.Console, key string, spec TemplateInput, override string) (string, error) {
	if len(override) > 0 {
		return validateInputValue(key, spec, override)
	}
	defaultValue := strings.TrimSpace(fmt.Sprintf("%v", spec.Default))
	if strings.EqualFold(defaultValue, "<nil>") {
		defaultValue = ""
	}
	if viper.GetBool("YES") {
		if len(defaultValue) > 0 {
			return validateInputValue(key, spec, defaultValue)
		}
		if spec.Required {
			return "", errors.Errorf("missing required template input %q: rerun with --input %s=value", key, key)
		}
		return "", nil
	}
	switch strings.ToLower(spec.Type) {
	case "select":
		if len(spec.Options) == 0 {
			return "", errors.Errorf("template input %q has type select without options", key)
		}
		items := make([]utils.PromptItem, len(spec.Options))
		for i, option := range spec.Options {
			items[i] = utils.PromptItem{Summary: option, Index: i}
		}
		title := spec.Label
		if len(strings.TrimSpace(title)) == 0 {
			title = "Select value for " + key
		}
		choice, err := utils.PromptChoice(ctx, title, items)
		if err != nil {
			return "", err
		}
		return validateInputValue(key, spec, choice.Summary)
	case "password":
		label := inputLabel(key, spec, "")
		fmt.Fprint(os.Stderr, label)
		val := strings.TrimSpace(credentials.PromptMasked(os.Stdin))
		if len(val) == 0 {
			val = defaultValue
		}
		return validateInputValue(key, spec, val)
	default:
		label := inputLabel(key, spec, defaultValue)
		val, err := console.PromptText(ctx, label)
		if err != nil {
			return "", err
		}
		val = strings.TrimSpace(val)
		if len(val) == 0 {
			val = defaultValue
		}
		return validateInputValue(key, spec, val)
	}
}

func inputLabel(key string, spec TemplateInput, defaultValue string) string {
	label := spec.Label
	if len(strings.TrimSpace(label)) == 0 {
		label = key
	}
	if len(defaultValue) > 0 {
		label += fmt.Sprintf(" [default: %s]", defaultValue)
	}
	return label + ": "
}

func validateInputValue(key string, spec TemplateInput, value string) (string, error) {
	value = strings.TrimSpace(value)
	if len(value) == 0 {
		if spec.Required {
			return "", errors.Errorf("template input %q is required", key)
		}
		return "", nil
	}
	switch strings.ToLower(spec.Type) {
	case "number":
		if _, err := strconv.ParseFloat(value, 64); err != nil {
			return "", errors.Errorf("template input %q must be a number: %w", key, err)
		}
	case "select":
		if len(spec.Options) == 0 {
			return "", errors.Errorf("template input %q has no select options", key)
		}
		valid := false
		for _, option := range spec.Options {
			if option == value {
				valid = true
				break
			}
		}
		if !valid {
			return "", errors.Errorf("template input %q must be one of %v", key, spec.Options)
		}
	}
	return value, nil
}

func executeComponent(ctx context.Context, src *templateSource, c TemplateComponent, fsys afero.Fs, state *runtimeState) error {
	componentType, err := renderValue(c.Type, state.contextValues, state.refs)
	if err != nil {
		return err
	}
	componentType = strings.TrimSpace(componentType)
	switch {
	case isSchemaComponentType(componentType):
		return executeSQLComponent(src, c, componentType, fsys, state)
	case componentType == "edge_function":
		return executeEdgeFunctionComponent(src, c, fsys, state)
	case componentType == "secret":
		return executeSecretComponent(c, state)
	case componentType == "vault":
		return executeVaultComponent(c, state)
	default:
		return errors.Errorf("unsupported template component type: %s", componentType)
	}
}

func executeSQLComponent(src *templateSource, c TemplateComponent, componentType string, fsys afero.Fs, state *runtimeState) error {
	templatePaths, err := renderComponentPaths(c.Path, state.contextValues, state.refs)
	if err != nil {
		return err
	}
	if len(templatePaths) == 0 {
		return errors.Errorf("%s component requires path", componentType)
	}
	if len(templatePaths) > 1 {
		return errors.Errorf("%s component expects a single path, found %d", componentType, len(templatePaths))
	}
	templatePath := templatePaths[0]
	sqlData, err := src.readTemplatePath(templatePath, true)
	if err != nil {
		return err
	}
	sqlContent, err := renderValue(string(sqlData), state.contextValues, state.refs)
	if err != nil {
		return err
	}
	name := strings.TrimSpace(c.Name)
	if len(name) == 0 {
		name = strings.TrimSuffix(filepath.Base(templatePath), filepath.Ext(templatePath))
	}
	name, err = renderValue(name, state.contextValues, state.refs)
	if err != nil {
		return err
	}
	if len(name) == 0 {
		return errors.Errorf("unable to resolve component name for %s", componentType)
	}
	schema := c.Schema
	if len(strings.TrimSpace(schema)) == 0 {
		schema = "public"
	}
	schema, err = renderValue(schema, state.contextValues, state.refs)
	if err != nil {
		return err
	}
	defaultPath := defaultSQLPath(componentType, schema, name)
	destPath := placement.ResolvePath(componentType, utils.Config.Db.Migrations.SchemaPlacement, placement.Context{
		Schema:      schema,
		Name:        name,
		DefaultPath: defaultPath,
	})
	if err := utils.MkdirIfNotExistFS(fsys, filepath.Dir(destPath)); err != nil {
		return err
	}
	changed, err := mergeSQLFile(destPath, sqlContent, fsys)
	if err != nil {
		return err
	}
	if changed {
		state.addedSql = append(state.addedSql, destPath)
	}
	setComponentRefs(name, map[string]string{
		"path": destPath,
	}, state.refs)
	return applyOutputs(c, state)
}

func executeEdgeFunctionComponent(src *templateSource, c TemplateComponent, fsys afero.Fs, state *runtimeState) error {
	paths, err := renderComponentPaths(c.Path, state.contextValues, state.refs)
	if err != nil {
		return err
	}
	if len(paths) == 0 {
		return errors.New("edge_function component requires path")
	}
	slug := strings.TrimSpace(c.Name)
	if len(slug) > 0 {
		var err error
		slug, err = renderValue(slug, state.contextValues, state.refs)
		if err != nil {
			return err
		}
		slug = strings.TrimSpace(slug)
	}
	if len(slug) == 0 {
		slug = inferFunctionSlugFromPaths(paths)
	}
	if len(slug) == 0 {
		return errors.New("edge_function component requires a name when slug cannot be inferred from path")
	}
	if err := utils.ValidateFunctionSlug(slug); err != nil {
		return err
	}
	destDir := filepath.Join(utils.FunctionsDir, slug)
	if err := utils.MkdirIfNotExistFS(fsys, destDir); err != nil {
		return err
	}
	if src.isRemote {
		if len(paths) == 1 && path.Ext(refPathKey(paths[0])) == "" {
			return errors.New("remote edge_function path must be a file or file array; for directories, provide path as an array of files")
		}
		if err := copyFunctionFilesFromRemoteRefs(src, paths, destDir, state.contextValues, state.refs, fsys); err != nil {
			return err
		}
	} else {
		copiedDirectory := false
		if len(paths) == 1 {
			if localPath, err := src.resolveLocalPath(paths[0]); err == nil {
				if info, err := src.fsys.Stat(localPath); err == nil && info.IsDir() {
					if err := copyLocalFunctionDirectory(src, paths[0], destDir, state.contextValues, state.refs, fsys); err != nil {
						return err
					}
					copiedDirectory = true
				}
			}
		}
		if !copiedDirectory {
			if err := copyFunctionFilesFromLocalRefs(src, paths, destDir, state.contextValues, state.refs, fsys); err != nil {
				return err
			}
		}
	}
	state.config.ensureFunctionConfig(slug)
	refName := strings.TrimSpace(c.Name)
	if len(refName) == 0 {
		refName = slug
	} else if rendered, err := renderValue(refName, state.contextValues, state.refs); err == nil {
		refName = strings.TrimSpace(rendered)
	}
	setComponentRefs(refName, map[string]string{
		"url":  utils.GetApiUrl("/functions/v1/" + slug),
		"slug": slug,
		"path": destDir,
	}, state.refs)
	return applyOutputs(c, state)
}

func mergeSQLFile(destPath, incomingSQL string, fsys afero.Fs) (bool, error) {
	block := strings.TrimSpace(incomingSQL)
	if len(block) == 0 {
		return false, nil
	}
	existing, err := afero.ReadFile(fsys, destPath)
	if errors.Is(err, os.ErrNotExist) {
		content := block + "\n"
		if err := afero.WriteFile(fsys, destPath, []byte(content), 0644); err != nil {
			return false, errors.Errorf("failed to write SQL component: %w", err)
		}
		return true, nil
	} else if err != nil {
		return false, errors.Errorf("failed to read SQL component for merge: %w", err)
	}
	existingText := string(existing)
	if strings.Contains(existingText, block) {
		return false, nil
	}
	merged := strings.TrimRight(existingText, "\n")
	if len(strings.TrimSpace(merged)) > 0 {
		merged += "\n\n"
	}
	merged += block + "\n"
	if err := afero.WriteFile(fsys, destPath, []byte(merged), 0644); err != nil {
		return false, errors.Errorf("failed to write SQL component: %w", err)
	}
	return true, nil
}

func executeSecretComponent(c TemplateComponent, state *runtimeState) error {
	key, err := renderValue(c.Key, state.contextValues, state.refs)
	if err != nil {
		return err
	}
	key = strings.TrimSpace(key)
	if len(key) == 0 {
		return errors.New("secret component requires key")
	}
	state.config.ensureSecretConfig(sectionEdgeSecrets, key)
	return applyOutputs(c, state)
}

func executeVaultComponent(c TemplateComponent, state *runtimeState) error {
	key, err := renderValue(c.Key, state.contextValues, state.refs)
	if err != nil {
		return err
	}
	key = strings.TrimSpace(key)
	if len(key) == 0 {
		return errors.New("vault component requires key")
	}
	state.config.ensureSecretConfig(sectionDbVault, key)
	return applyOutputs(c, state)
}

func applyOutputs(c TemplateComponent, state *runtimeState) error {
	if len(c.Output) == 0 {
		return nil
	}
	keys := make([]string, 0, len(c.Output))
	for k := range c.Output {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, key := range keys {
		raw := c.Output[key]
		val, err := renderValue(raw, state.contextValues, state.refs)
		if err != nil {
			return err
		}
		state.contextValues[key] = val
	}
	return nil
}

func setComponentRefs(componentName string, values map[string]string, refs map[string]string) {
	name := strings.TrimSpace(componentName)
	if len(name) == 0 {
		return
	}
	for key, value := range values {
		refs[name+"."+key] = value
	}
}

func defaultSQLPath(componentType, schema, name string) string {
	switch componentType {
	case "types":
		return filepath.Join(utils.SchemasDir, "types.sql")
	case "tables":
		return filepath.Join(utils.SchemasDir, "tables", name+".sql")
	case "functions":
		return filepath.Join(utils.SchemasDir, "functions", name+".sql")
	case "triggers":
		return filepath.Join(utils.SchemasDir, "triggers", name+".sql")
	case "policies":
		return filepath.Join(utils.SchemasDir, "policies", name+".sql")
	case "extensions":
		return filepath.Join(utils.SchemasDir, "extensions.sql")
	case "schemas":
		return filepath.Join(utils.SchemasDir, schema, "schema.sql")
	default:
		return filepath.Join(utils.SchemasDir, name+".sql")
	}
}

func isSchemaComponentType(componentType string) bool {
	switch componentType {
	case "schemas", "types", "sequences", "tables", "foreign_tables", "functions", "triggers", "procedures",
		"materialized_views", "views", "policies", "domains", "operators", "roles", "extensions",
		"foreign_data_wrappers", "publications", "subscriptions", "event_triggers", "tablespaces",
		"variables", "unqualified":
		return true
	default:
		return false
	}
}

func renderComponentPaths(rawPaths TemplatePath, context map[string]string, refs map[string]string) ([]string, error) {
	paths := make([]string, 0, len(rawPaths))
	for _, raw := range rawPaths {
		rendered, err := renderValue(raw, context, refs)
		if err != nil {
			return nil, err
		}
		rendered = strings.TrimSpace(rendered)
		if len(rendered) > 0 {
			paths = append(paths, rendered)
		}
	}
	return paths, nil
}

func inferFunctionSlugFromPaths(paths []string) string {
	if len(paths) == 0 {
		return ""
	}
	ref := refPathKey(paths[0])
	base := path.Base(ref)
	if strings.EqualFold(base, "index.ts") || strings.EqualFold(base, "index.js") || strings.EqualFold(base, "index.tsx") || strings.EqualFold(base, "index.jsx") {
		return path.Base(path.Dir(ref))
	}
	if ext := path.Ext(base); len(ext) > 0 {
		return path.Base(path.Dir(ref))
	}
	return path.Base(ref)
}

func copyLocalFunctionDirectory(src *templateSource, componentPath, destDir string, context map[string]string, refs map[string]string, fsys afero.Fs) error {
	sourceDir, err := src.resolveLocalPath(componentPath)
	if err != nil {
		return err
	}
	return afero.Walk(src.fsys, sourceDir, func(fp string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(sourceDir, fp)
		if err != nil {
			return err
		}
		target := filepath.Join(destDir, rel)
		if info.IsDir() {
			return utils.MkdirIfNotExistFS(fsys, target)
		}
		data, err := afero.ReadFile(src.fsys, fp)
		if err != nil {
			return err
		}
		if shouldRenderFile(fp) {
			if rendered, err := renderValue(string(data), context, refs); err == nil {
				data = []byte(rendered)
			}
		}
		if err := utils.MkdirIfNotExistFS(fsys, filepath.Dir(target)); err != nil {
			return err
		}
		return afero.WriteFile(fsys, target, data, info.Mode())
	})
}

func copyFunctionFilesFromLocalRefs(src *templateSource, refsList []string, destDir string, context map[string]string, refs map[string]string, fsys afero.Fs) error {
	normalized := make([]string, 0, len(refsList))
	for _, item := range refsList {
		normalized = append(normalized, refPathKey(item))
	}
	baseDir := commonPathDir(normalized)
	wroteEntrypoint := false
	for i, ref := range refsList {
		sourcePath, err := src.resolveLocalPath(ref)
		if err != nil {
			return err
		}
		info, err := src.fsys.Stat(sourcePath)
		if err != nil {
			return err
		}
		if info.IsDir() {
			return errors.Errorf("edge_function path item must be a file, got directory: %s", ref)
		}
		rel, err := relativeFromCommonPrefix(baseDir, normalized[i])
		if err != nil {
			return err
		}
		data, err := afero.ReadFile(src.fsys, sourcePath)
		if err != nil {
			return err
		}
		if shouldRenderFile(rel) {
			if rendered, err := renderValue(string(data), context, refs); err == nil {
				data = []byte(rendered)
			}
		}
		dest := filepath.Join(destDir, filepath.FromSlash(rel))
		if err := utils.MkdirIfNotExistFS(fsys, filepath.Dir(dest)); err != nil {
			return err
		}
		if err := afero.WriteFile(fsys, dest, data, info.Mode()); err != nil {
			return err
		}
		if rel == "index.ts" {
			wroteEntrypoint = true
		}
	}
	if !wroteEntrypoint {
		return errors.New("missing edge function entrypoint index.ts")
	}
	return nil
}

func copyFunctionFilesFromRemoteRefs(src *templateSource, refsList []string, destDir string, context map[string]string, refs map[string]string, fsys afero.Fs) error {
	normalized := make([]string, 0, len(refsList))
	for _, item := range refsList {
		normalized = append(normalized, refPathKey(item))
	}
	baseDir := commonPathDir(normalized)
	wroteEntrypoint := false
	for i, ref := range refsList {
		data, err := src.readTemplatePath(ref, true)
		if err != nil {
			return err
		}
		rel, err := relativeFromCommonPrefix(baseDir, normalized[i])
		if err != nil {
			return err
		}
		if shouldRenderFile(rel) {
			if rendered, err := renderValue(string(data), context, refs); err == nil {
				data = []byte(rendered)
			}
		}
		dest := filepath.Join(destDir, filepath.FromSlash(rel))
		if err := utils.MkdirIfNotExistFS(fsys, filepath.Dir(dest)); err != nil {
			return err
		}
		if err := afero.WriteFile(fsys, dest, data, 0644); err != nil {
			return err
		}
		if rel == "index.ts" {
			wroteEntrypoint = true
		}
	}
	if !wroteEntrypoint {
		return errors.New("missing edge function entrypoint index.ts")
	}
	return nil
}

func refPathKey(raw string) string {
	if parsed, err := url.Parse(raw); err == nil && len(parsed.Scheme) > 0 && len(parsed.Host) > 0 {
		return path.Clean(parsed.Path)
	}
	return path.Clean(filepath.ToSlash(raw))
}

func commonPathDir(paths []string) string {
	if len(paths) == 0 {
		return ""
	}
	base := strings.Split(path.Dir(paths[0]), "/")
	for _, p := range paths[1:] {
		parts := strings.Split(path.Dir(p), "/")
		n := len(base)
		if len(parts) < n {
			n = len(parts)
		}
		i := 0
		for i < n && base[i] == parts[i] {
			i++
		}
		base = base[:i]
		if len(base) == 0 {
			break
		}
	}
	return strings.Join(base, "/")
}

func relativeFromCommonPrefix(baseDir, fullPath string) (string, error) {
	baseDir = strings.TrimSuffix(baseDir, "/")
	fullPath = path.Clean(fullPath)
	rel := fullPath
	if len(baseDir) > 0 {
		prefix := baseDir + "/"
		rel = strings.TrimPrefix(fullPath, prefix)
	}
	rel = strings.TrimPrefix(rel, "/")
	if len(rel) == 0 {
		rel = path.Base(fullPath)
	}
	rel = path.Clean(rel)
	if rel == "." || strings.HasPrefix(rel, "../") {
		return "", errors.Errorf("invalid function file path: %s", fullPath)
	}
	return rel, nil
}

func shouldRenderFile(filename string) bool {
	switch strings.ToLower(filepath.Ext(filename)) {
	case ".sql", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".json", ".jsonc", ".md", ".txt", ".yaml", ".yml", ".toml":
		return true
	default:
		return false
	}
}
