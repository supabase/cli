package add

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"github.com/go-errors/errors"
	"github.com/joho/godotenv"
	"github.com/spf13/afero"
	"github.com/spf13/viper"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/credentials"
	"github.com/supabase/cli/internal/utils/flags"
)

type runtimeState struct {
	ctx           context.Context
	contextValues map[string]string
	refs          map[string]string
	config        *configEditor
}

func Run(ctx context.Context, source string, inputArgs []string, raw bool, fsys afero.Fs) error {
	if err := flags.LoadConfig(fsys); err != nil {
		return err
	}
	src, templateBody, err := newTemplateSource(ctx, source, fsys)
	if err != nil {
		return err
	}
	if raw {
		var buf bytes.Buffer
		if err := json.Indent(&buf, templateBody, "", "  "); err != nil {
			// fallback to raw bytes if not valid JSON
			fmt.Println(string(templateBody))
			return nil
		}
		fmt.Println(buf.String())
		return nil
	}
	tmpl, err := parseTemplateManifest(templateBody)
	if err != nil {
		return err
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
		ctx:           ctx,
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
	if err := state.config.save(fsys); err != nil {
		return err
	}
	fmt.Println("Finished " + utils.Aqua("supabase add") + ".")
	if err := showPostInstallMessage(tmpl.PostInstall, state.contextValues, state.refs); err != nil {
		return err
	}
	return nil
}

func parseTemplateManifest(data []byte) (Template, error) {
	var tmpl Template
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&tmpl); err != nil {
		return tmpl, errors.Errorf("template manifest has invalid JSON format: %w", err)
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		if err == nil {
			return tmpl, errors.New("template manifest must contain a single JSON object")
		}
		return tmpl, errors.Errorf("template manifest has invalid JSON format: %w", err)
	}
	if err := validateTemplateManifest(tmpl); err != nil {
		return tmpl, err
	}
	return tmpl, nil
}

func validateTemplateManifest(tmpl Template) error {
	if len(strings.TrimSpace(tmpl.Name)) == 0 {
		return errors.New("template manifest missing name")
	}
	inputKeys := make([]string, 0, len(tmpl.Inputs))
	for key := range tmpl.Inputs {
		inputKeys = append(inputKeys, key)
	}
	sort.Strings(inputKeys)
	for _, key := range inputKeys {
		spec := tmpl.Inputs[key]
		typ := strings.ToLower(strings.TrimSpace(spec.Type))
		switch typ {
		case "", "string", "number", "password", "boolean", "bool":
		case "select":
			if len(spec.Options) == 0 {
				return errors.Errorf("template input %q of type select requires at least one option", key)
			}
			for i, option := range spec.Options {
				if len(strings.TrimSpace(option)) == 0 {
					return errors.Errorf("template input %q has an empty option at index %d", key, i)
				}
			}
		}
	}
	for i, step := range tmpl.Steps {
		for j, component := range step.Components {
			if len(strings.TrimSpace(component.Type)) == 0 {
				return errors.Errorf("template step %d component %d requires type", i+1, j+1)
			}
		}
	}
	return nil
}

func showPostInstallMessage(spec *TemplatePostInstall, context map[string]string, refs map[string]string) error {
	if spec == nil {
		return nil
	}
	title, err := renderValue(spec.Title, context, refs)
	if err != nil {
		return err
	}
	message, err := renderValue(spec.Message, context, refs)
	if err != nil {
		return err
	}
	if len(strings.TrimSpace(title)) == 0 && len(strings.TrimSpace(message)) == 0 {
		return nil
	}
	fmt.Println()
	if len(strings.TrimSpace(title)) > 0 {
		fmt.Println(strings.TrimSpace(title))
	}
	if len(message) > 0 {
		fmt.Print(message)
		if !strings.HasSuffix(message, "\n") {
			fmt.Println()
		}
	}
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
	case "boolean", "bool":
		if _, err := strconv.ParseBool(value); err != nil {
			return "", errors.Errorf("template input %q must be a boolean: %w", key, err)
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
	if len(componentType) == 0 {
		return errors.New("template component requires type")
	}
	switch componentType {
	case "migration":
		return executeMigrationComponent(src, c, fsys, state)
	case "edge_function":
		return executeEdgeFunctionComponent(src, c, fsys, state)
	case "secret":
		return executeSecretComponent(c, fsys, state)
	case "vault":
		return executeVaultComponent(c, state)
	default:
		return errors.Errorf("unsupported component type: %s", componentType)
	}
}

func executeMigrationComponent(src *templateSource, c TemplateComponent, fsys afero.Fs, state *runtimeState) error {
	templatePaths, err := renderComponentPaths(c.Path, state.contextValues, state.refs)
	if err != nil {
		return err
	}
	if len(templatePaths) == 0 {
		return errors.New("migration component requires path")
	}
	if len(templatePaths) > 1 {
		return errors.Errorf("migration component expects a single path, found %d", len(templatePaths))
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
		return errors.New("migration component requires a name")
	}
	filename := name
	if !strings.EqualFold(filepath.Ext(filename), ".sql") {
		filename += ".sql"
	}
	destPath := filepath.Join(utils.MigrationsDir, filename)
	if err := utils.MkdirIfNotExistFS(fsys, utils.MigrationsDir); err != nil {
		return err
	}
	if err := confirmComponentFileOverwrite(state.ctx, fsys, "migration", name, []string{destPath}); err != nil {
		return err
	}
	content := strings.TrimSpace(sqlContent) + "\n"
	if err := afero.WriteFile(fsys, destPath, []byte(content), 0644); err != nil {
		return errors.Errorf("failed to write migration file: %w", err)
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
		if err := copyFunctionFilesFromRemoteRefs(state.ctx, src, paths, destDir, slug, state.contextValues, state.refs, fsys); err != nil {
			return err
		}
	} else {
		copiedDirectory := false
		if len(paths) == 1 {
			if localPath, err := src.resolveLocalPath(paths[0]); err == nil {
				if info, err := src.fsys.Stat(localPath); err == nil && info.IsDir() {
					if err := copyLocalFunctionDirectory(state.ctx, src, paths[0], destDir, slug, state.contextValues, state.refs, fsys); err != nil {
						return err
					}
					copiedDirectory = true
				}
			}
		}
		if !copiedDirectory {
				if err := copyFunctionFilesFromLocalRefs(state.ctx, src, paths, destDir, slug, state.contextValues, state.refs, fsys); err != nil {
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

func executeSecretComponent(c TemplateComponent, fsys afero.Fs, state *runtimeState) error {
	key, err := renderValue(c.Key, state.contextValues, state.refs)
	if err != nil {
		return err
	}
	key = strings.TrimSpace(key)
	if len(key) == 0 {
		return errors.New("secret component requires key")
	}
	value, err := renderValue(c.Value, state.contextValues, state.refs)
	if err != nil {
		return err
	}
	if err := upsertFunctionsEnv(key, value, fsys); err != nil {
		return err
	}
	state.config.ensureSecretConfig(sectionEdgeSecrets, key)
	return applyOutputs(c, state)
}

func upsertFunctionsEnv(key, value string, fsys afero.Fs) error {
	path := utils.FallbackEnvFilePath
	envMap := map[string]string{}
	f, err := fsys.Open(path)
	if err == nil {
		defer f.Close()
		parsed, err := godotenv.Parse(f)
		if err != nil {
			return errors.Errorf("failed to parse %s: %w", path, err)
		}
		envMap = parsed
	} else if !errors.Is(err, os.ErrNotExist) {
		return errors.Errorf("failed to read %s: %w", path, err)
	}
	envMap[key] = value
	content, err := godotenv.Marshal(envMap)
	if err != nil {
		return errors.Errorf("failed to marshal %s: %w", path, err)
	}
	if err := utils.WriteFile(path, []byte(content), fsys); err != nil {
		return errors.Errorf("failed to write %s: %w", path, err)
	}
	return nil
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

type plannedFileWrite struct {
	target string
	data   []byte
	mode   os.FileMode
	rel    string
}

func confirmComponentFileOverwrite(ctx context.Context, fsys afero.Fs, componentType, componentName string, targets []string) error {
	seen := make(map[string]struct{}, len(targets))
	existing := make([]string, 0, len(targets))
	for _, target := range targets {
		target = filepath.Clean(strings.TrimSpace(target))
		if len(target) == 0 {
			continue
		}
		if _, ok := seen[target]; ok {
			continue
		}
		seen[target] = struct{}{}
		info, err := fsys.Stat(target)
		if err == nil {
			if !info.IsDir() {
				existing = append(existing, target)
			}
			continue
		}
		if !errors.Is(err, os.ErrNotExist) {
			return errors.Errorf("failed to check existing file %s: %w", target, err)
		}
	}
	if len(existing) == 0 {
		return nil
	}
	sort.Strings(existing)
	name := strings.TrimSpace(componentName)
	if len(name) == 0 {
		name = componentType
	}
	message := fmt.Sprintf("Component %s (%s) will overwrite %d file(s):", componentType, utils.Bold(name), len(existing))
	showCount := len(existing)
	if showCount > 5 {
		showCount = 5
	}
	for _, target := range existing[:showCount] {
		message += "\n - " + target
	}
	if len(existing) > showCount {
		message += fmt.Sprintf("\n - ...and %d more", len(existing)-showCount)
	}
	message += "\nContinue?"
	if ctx == nil {
		ctx = context.Background()
	}
	shouldOverwrite, err := utils.NewConsole().PromptYesNo(ctx, message, false)
	if err != nil {
		return err
	}
	if !shouldOverwrite {
		return errors.New(context.Canceled)
	}
	return nil
}

func writePlannedFiles(planned []plannedFileWrite, fsys afero.Fs) error {
	for _, file := range planned {
		if err := utils.MkdirIfNotExistFS(fsys, filepath.Dir(file.target)); err != nil {
			return err
		}
		if err := afero.WriteFile(fsys, file.target, file.data, file.mode); err != nil {
			return err
		}
	}
	return nil
}

func copyLocalFunctionDirectory(ctx context.Context, src *templateSource, componentPath, destDir, componentName string, context map[string]string, refs map[string]string, fsys afero.Fs) error {
	sourceDir, err := src.resolveLocalPath(componentPath)
	if err != nil {
		return err
	}
	planned := make([]plannedFileWrite, 0)
	if err := afero.Walk(src.fsys, sourceDir, func(fp string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.IsDir() {
			return nil
		}
		rel, err := filepath.Rel(sourceDir, fp)
		if err != nil {
			return err
		}
		rel = filepath.ToSlash(rel)
		target := filepath.Join(destDir, rel)
		data, err := afero.ReadFile(src.fsys, fp)
		if err != nil {
			return err
		}
		if shouldRenderFile(rel) {
			if rendered, err := renderValue(string(data), context, refs); err == nil {
				data = []byte(rendered)
			}
		}
		planned = append(planned, plannedFileWrite{
			target: target,
			data:   data,
			mode:   info.Mode(),
			rel:    rel,
		})
		return nil
	}); err != nil {
		return err
	}
	targets := make([]string, 0, len(planned))
	for _, file := range planned {
		targets = append(targets, file.target)
	}
	if err := confirmComponentFileOverwrite(ctx, fsys, "edge_function", componentName, targets); err != nil {
		return err
	}
	return writePlannedFiles(planned, fsys)
}

func copyFunctionFilesFromLocalRefs(ctx context.Context, src *templateSource, refsList []string, destDir, componentName string, context map[string]string, refs map[string]string, fsys afero.Fs) error {
	normalized, baseDir := normalizeFunctionRefs(refsList)
	entrypointPrefix := inferEntrypointPrefix(normalized, baseDir)
	planned := make([]plannedFileWrite, 0, len(refsList))
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
		dest, rel, err := resolveFunctionTargetPath(rel, entrypointPrefix, destDir)
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
		planned = append(planned, plannedFileWrite{
			target: dest,
			data:   data,
			mode:   info.Mode(),
			rel:    rel,
		})
		if rel == "index.ts" {
			wroteEntrypoint = true
		}
	}
	if !wroteEntrypoint {
		return errors.New("missing edge function entrypoint index.ts")
	}
	targets := make([]string, 0, len(planned))
	for _, file := range planned {
		targets = append(targets, file.target)
	}
	if err := confirmComponentFileOverwrite(ctx, fsys, "edge_function", componentName, targets); err != nil {
		return err
	}
	return writePlannedFiles(planned, fsys)
}

func copyFunctionFilesFromRemoteRefs(ctx context.Context, src *templateSource, refsList []string, destDir, componentName string, context map[string]string, refs map[string]string, fsys afero.Fs) error {
	normalized, baseDir := normalizeFunctionRefs(refsList)
	entrypointPrefix := inferEntrypointPrefix(normalized, baseDir)
	planned := make([]plannedFileWrite, 0, len(refsList))
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
		dest, rel, err := resolveFunctionTargetPath(rel, entrypointPrefix, destDir)
		if err != nil {
			return err
		}
		if shouldRenderFile(rel) {
			if rendered, err := renderValue(string(data), context, refs); err == nil {
				data = []byte(rendered)
			}
		}
		planned = append(planned, plannedFileWrite{
			target: dest,
			data:   data,
			mode:   0644,
			rel:    rel,
		})
		if rel == "index.ts" {
			wroteEntrypoint = true
		}
	}
	if !wroteEntrypoint {
		return errors.New("missing edge function entrypoint index.ts")
	}
	targets := make([]string, 0, len(planned))
	for _, file := range planned {
		targets = append(targets, file.target)
	}
	if err := confirmComponentFileOverwrite(ctx, fsys, "edge_function", componentName, targets); err != nil {
		return err
	}
	return writePlannedFiles(planned, fsys)
}

func normalizeFunctionRefs(refsList []string) ([]string, string) {
	normalized := make([]string, 0, len(refsList))
	for _, item := range refsList {
		normalized = append(normalized, refPathKey(item))
	}
	return normalized, commonPathDir(normalized)
}

func inferEntrypointPrefix(normalized []string, baseDir string) string {
	entrypointPrefix := ""
	for _, fullPath := range normalized {
		rel, err := relativeFromCommonPrefix(baseDir, fullPath)
		if err != nil || path.Base(rel) != "index.ts" {
			continue
		}
		dir := path.Dir(rel)
		if dir == "." {
			return ""
		}
		if len(entrypointPrefix) > 0 && entrypointPrefix != dir {
			return ""
		}
		entrypointPrefix = dir
	}
	return entrypointPrefix
}

func resolveFunctionTargetPath(relPath, entrypointPrefix, destDir string) (string, string, error) {
	relPath = path.Clean(strings.TrimPrefix(relPath, "/"))
	if len(entrypointPrefix) > 0 {
		prefix := entrypointPrefix + "/"
		if strings.HasPrefix(relPath, prefix) {
			relPath = strings.TrimPrefix(relPath, prefix)
		}
	}
	if relPath == "." || len(relPath) == 0 || strings.HasPrefix(relPath, "../") {
		return "", "", errors.Errorf("invalid function file path: %s", relPath)
	}
	destRoot := destDir
	if len(entrypointPrefix) > 0 && strings.HasPrefix(relPath, "_shared/") {
		destRoot = filepath.Dir(destDir)
	}
	return filepath.Join(destRoot, filepath.FromSlash(relPath)), relPath, nil
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
