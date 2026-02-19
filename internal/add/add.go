package add

import (
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
	mg "github.com/multigres/multigres/go/parser"
	"github.com/multigres/multigres/go/parser/ast"
	"github.com/spf13/afero"
	"github.com/spf13/viper"
	"github.com/supabase/cli/internal/component/placement"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/credentials"
	"github.com/supabase/cli/internal/utils/flags"
	sqlparser "github.com/supabase/cli/pkg/parser"
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
	if err := showPostInstallMessage(tmpl.PostInstall, state.contextValues, state.refs); err != nil {
		return err
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
	switch {
	case isSchemaComponentType(componentType):
		return executeSQLComponent(src, c, componentType, fsys, state)
	case componentType == "edge_function":
		return executeEdgeFunctionComponent(src, c, fsys, state)
	case componentType == "secret":
		return executeSecretComponent(c, fsys, state)
	case componentType == "vault":
		return executeVaultComponent(c, state)
	default:
		// Unknown component types fall back to SQL handling and default placement.
		return executeSQLComponent(src, c, componentType, fsys, state)
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
	mergedText, changed, structured := mergeSQLStatements(existingText, block)
	if structured {
		if !changed {
			return false, nil
		}
		if err := afero.WriteFile(fsys, destPath, []byte(mergedText), 0644); err != nil {
			return false, errors.Errorf("failed to write SQL component: %w", err)
		}
		return true, nil
	}
	if strings.Contains(existingText, block) {
		return false, nil
	}
	mergedTextFallback := strings.TrimRight(existingText, "\n")
	if len(strings.TrimSpace(mergedTextFallback)) > 0 {
		mergedTextFallback += "\n\n"
	}
	mergedTextFallback += block + "\n"
	if err := afero.WriteFile(fsys, destPath, []byte(mergedTextFallback), 0644); err != nil {
		return false, errors.Errorf("failed to write SQL component: %w", err)
	}
	return true, nil
}

type parsedSQLStatement struct {
	raw      string
	stmt     ast.Stmt
	parsed   bool
	modified bool
}

type createStmtRef struct {
	index int
	stmt  *ast.CreateStmt
}

func mergeSQLStatements(existingText, incomingText string) (string, bool, bool) {
	existingStatements, err := splitSQLStatements(strings.NewReader(existingText))
	if err != nil {
		return "", false, false
	}
	incomingStatements, err := splitSQLStatements(strings.NewReader(incomingText))
	if err != nil {
		return "", false, false
	}
	entries := make([]parsedSQLStatement, 0, len(existingStatements))
	creates := make([]createStmtRef, 0, len(existingStatements))
	seen := map[string]struct{}{}
	for _, raw := range existingStatements {
		entry := parseSQLStatement(raw)
		entries = append(entries, entry)
		seen[statementKey(entry)] = struct{}{}
		if createStmt, ok := entry.stmt.(*ast.CreateStmt); ok && createStmt != nil {
			creates = append(creates, createStmtRef{
				index: len(entries) - 1,
				stmt:  createStmt,
			})
		}
	}
	changed := false
	for _, raw := range incomingStatements {
		incoming := parseSQLStatement(raw)
		if _, found := seen[statementKey(incoming)]; found {
			continue
		}
		if alterStmt, ok := incoming.stmt.(*ast.AlterTableStmt); ok && alterStmt != nil {
			if target := findCreateStmtForAlter(alterStmt, creates); target != nil {
				handled, createChanged := applyAlterTableStmt(target.stmt, alterStmt)
				if handled {
					if createChanged {
						entries[target.index].modified = true
						seen[statementKey(entries[target.index])] = struct{}{}
						changed = true
					}
					// Skip appending the ALTER statement if it is already represented by CREATE TABLE.
					continue
				}
			}
		}
		entries = append(entries, incoming)
		seen[statementKey(incoming)] = struct{}{}
		changed = true
	}
	if !changed {
		return "", false, true
	}
	serialized := serializeSQLStatements(entries)
	return serialized, true, true
}

func splitSQLStatements(r io.Reader) ([]string, error) {
	return sqlparser.Split(r, strings.TrimSpace)
}

func parseSQLStatement(raw string) parsedSQLStatement {
	parsed, err := mg.ParseSQL(raw)
	if err != nil || len(parsed) != 1 {
		return parsedSQLStatement{raw: raw}
	}
	return parsedSQLStatement{
		raw:    raw,
		stmt:   parsed[0],
		parsed: true,
	}
}

func statementKey(stmt parsedSQLStatement) string {
	if stmt.parsed {
		if sql, ok := safeStmtSQL(stmt.stmt); ok {
			return canonicalSQL(sql)
		}
	}
	return canonicalSQL(stmt.raw)
}

func safeStmtSQL(stmt ast.Stmt) (string, bool) {
	if stmt == nil {
		return "", false
	}
	defer func() {
		_ = recover()
	}()
	return stmt.SqlString(), true
}

func serializeSQLStatements(entries []parsedSQLStatement) string {
	lines := make([]string, 0, len(entries))
	for _, entry := range entries {
		text := strings.TrimSpace(entry.raw)
		if entry.modified && entry.parsed {
			if sql, ok := safeStmtSQL(entry.stmt); ok {
				text = strings.TrimSpace(sql)
			}
		}
		text = strings.TrimSpace(strings.TrimSuffix(text, ";"))
		if len(text) == 0 {
			continue
		}
		lines = append(lines, text+";")
	}
	if len(lines) == 0 {
		return ""
	}
	return strings.Join(lines, "\n") + "\n"
}

func canonicalSQL(sql string) string {
	trimmed := strings.TrimSpace(strings.TrimSuffix(sql, ";"))
	if len(trimmed) == 0 {
		return ""
	}
	return strings.Join(strings.Fields(strings.ToLower(trimmed)), " ")
}

func findCreateStmtForAlter(alter *ast.AlterTableStmt, creates []createStmtRef) *createStmtRef {
	if alter == nil || alter.Relation == nil || len(creates) == 0 {
		return nil
	}
	alterSchema := normalizeIdentifier(alter.Relation.SchemaName)
	alterName := normalizeIdentifier(alter.Relation.RelName)
	if len(alterName) == 0 {
		return nil
	}
	byName := make([]*createStmtRef, 0, 1)
	for i := range creates {
		c := &creates[i]
		if c.stmt == nil || c.stmt.Relation == nil {
			continue
		}
		createSchema := normalizeIdentifier(c.stmt.Relation.SchemaName)
		createName := normalizeIdentifier(c.stmt.Relation.RelName)
		if createName != alterName {
			continue
		}
		if len(alterSchema) > 0 && createSchema == alterSchema {
			return c
		}
		byName = append(byName, c)
	}
	if len(byName) == 1 {
		return byName[0]
	}
	return nil
}

func normalizeIdentifier(value string) string {
	return strings.ToLower(strings.TrimSpace(value))
}

func applyAlterTableStmt(create *ast.CreateStmt, alter *ast.AlterTableStmt) (bool, bool) {
	if create == nil || alter == nil || alter.Cmds == nil || alter.Cmds.Len() == 0 {
		return false, false
	}
	clone, ok := cloneCreateStmt(create)
	if !ok {
		return false, false
	}
	changed := false
	for _, item := range alter.Cmds.Items {
		cmd, ok := item.(*ast.AlterTableCmd)
		if !ok || cmd == nil {
			return false, false
		}
		applied, cmdChanged := applyAlterTableCmd(clone, cmd)
		if !applied {
			return false, false
		}
		changed = changed || cmdChanged
	}
	if changed {
		*create = *clone
	}
	return true, changed
}

func cloneCreateStmt(create *ast.CreateStmt) (*ast.CreateStmt, bool) {
	sql, ok := safeStmtSQL(create)
	if !ok {
		return nil, false
	}
	parsed, err := mg.ParseSQL(sql)
	if err != nil || len(parsed) != 1 {
		return nil, false
	}
	cloned, ok := parsed[0].(*ast.CreateStmt)
	if !ok {
		return nil, false
	}
	return cloned, true
}

func applyAlterTableCmd(create *ast.CreateStmt, cmd *ast.AlterTableCmd) (bool, bool) {
	switch cmd.Subtype {
	case ast.AT_AddColumn:
		return applyAddColumn(create, cmd)
	case ast.AT_DropColumn:
		return applyDropColumn(create, cmd)
	case ast.AT_ColumnDefault:
		return applyColumnDefault(create, cmd)
	case ast.AT_SetNotNull:
		return applySetNotNull(create, cmd)
	case ast.AT_DropNotNull:
		return applyDropNotNull(create, cmd)
	case ast.AT_AlterColumnType:
		return applyAlterColumnType(create, cmd)
	case ast.AT_AddConstraint:
		return applyAddConstraint(create, cmd)
	case ast.AT_DropConstraint:
		return applyDropConstraint(create, cmd)
	case ast.AT_AddIdentity:
		return applyAddIdentity(create, cmd)
	case ast.AT_SetIdentity:
		return applySetIdentity(create, cmd)
	case ast.AT_DropIdentity:
		return applyDropIdentity(create, cmd)
	default:
		return false, false
	}
}

func applyAddColumn(create *ast.CreateStmt, cmd *ast.AlterTableCmd) (bool, bool) {
	col, ok := cmd.Def.(*ast.ColumnDef)
	if !ok || col == nil || len(strings.TrimSpace(col.Colname)) == 0 {
		return false, false
	}
	if existing := findColumnDef(create, col.Colname); existing != nil {
		if cmd.MissingOk || sameNodeSQL(existing, col) {
			return true, false
		}
		return false, false
	}
	if create.TableElts == nil {
		create.TableElts = ast.NewNodeList()
	}
	create.TableElts.Append(col)
	return true, true
}

func applyDropColumn(create *ast.CreateStmt, cmd *ast.AlterTableCmd) (bool, bool) {
	if len(strings.TrimSpace(cmd.Name)) == 0 {
		return false, false
	}
	if create.TableElts == nil || create.TableElts.Len() == 0 {
		return cmd.MissingOk, false
	}
	changed := false
	filtered := make([]ast.Node, 0, len(create.TableElts.Items))
	for _, item := range create.TableElts.Items {
		if col, ok := item.(*ast.ColumnDef); ok && identifierEquals(col.Colname, cmd.Name) {
			changed = true
			continue
		}
		filtered = append(filtered, item)
	}
	if !changed {
		return cmd.MissingOk, false
	}
	create.TableElts.Items = filtered
	return true, true
}

func applyColumnDefault(create *ast.CreateStmt, cmd *ast.AlterTableCmd) (bool, bool) {
	col := findColumnDef(create, cmd.Name)
	if col == nil {
		return false, false
	}
	if cmd.Def == nil {
		changed := clearColumnDefault(col)
		return true, changed
	}
	if defaultNodeSQL(col) == canonicalNodeSQL(cmd.Def) {
		return true, false
	}
	clearColumnDefault(col)
	defaultConstraint := ast.NewConstraint(ast.CONSTR_DEFAULT)
	defaultConstraint.RawExpr = cmd.Def
	ensureColumnConstraints(col).Append(defaultConstraint)
	return true, true
}

func applySetNotNull(create *ast.CreateStmt, cmd *ast.AlterTableCmd) (bool, bool) {
	col := findColumnDef(create, cmd.Name)
	if col == nil {
		return false, false
	}
	if columnHasConstraintType(col, ast.CONSTR_NOTNULL) || col.IsNotNull {
		return true, false
	}
	constraint := ast.NewConstraint(ast.CONSTR_NOTNULL)
	ensureColumnConstraints(col).Append(constraint)
	col.IsNotNull = false
	return true, true
}

func applyDropNotNull(create *ast.CreateStmt, cmd *ast.AlterTableCmd) (bool, bool) {
	col := findColumnDef(create, cmd.Name)
	if col == nil {
		return false, false
	}
	changed := removeColumnConstraints(col, func(c *ast.Constraint) bool {
		return c.Contype == ast.CONSTR_NOTNULL
	})
	if col.IsNotNull {
		col.IsNotNull = false
		changed = true
	}
	return true, changed
}

func applyAlterColumnType(create *ast.CreateStmt, cmd *ast.AlterTableCmd) (bool, bool) {
	col := findColumnDef(create, cmd.Name)
	if col == nil {
		return false, false
	}
	def, ok := cmd.Def.(*ast.ColumnDef)
	if !ok || def == nil || def.TypeName == nil {
		return false, false
	}
	// TYPE ... USING cannot be represented directly in CREATE TABLE.
	if def.RawDefault != nil {
		return false, false
	}
	if sameNodeSQL(col.TypeName, def.TypeName) {
		return true, false
	}
	col.TypeName = def.TypeName
	return true, true
}

func applyAddConstraint(create *ast.CreateStmt, cmd *ast.AlterTableCmd) (bool, bool) {
	constraint, ok := cmd.Def.(*ast.Constraint)
	if !ok || constraint == nil {
		return false, false
	}
	existing, found := findConstraint(create, constraint.Conname, constraint)
	if found {
		if sameNodeSQL(existing, constraint) || samePrimaryKeyConstraint(create, existing, constraint) {
			return true, false
		}
		return false, false
	}
	if create.TableElts == nil {
		create.TableElts = ast.NewNodeList()
	}
	create.TableElts.Append(constraint)
	return true, true
}

func applyDropConstraint(create *ast.CreateStmt, cmd *ast.AlterTableCmd) (bool, bool) {
	if len(strings.TrimSpace(cmd.Name)) == 0 {
		return false, false
	}
	changed := false
	if create.TableElts != nil {
		filtered := make([]ast.Node, 0, len(create.TableElts.Items))
		for _, item := range create.TableElts.Items {
			if constraint, ok := item.(*ast.Constraint); ok && identifierEquals(constraint.Conname, cmd.Name) {
				changed = true
				continue
			}
			filtered = append(filtered, item)
		}
		create.TableElts.Items = filtered
	}
	if len(create.Constraints) > 0 {
		filtered := make([]*ast.Constraint, 0, len(create.Constraints))
		for _, constraint := range create.Constraints {
			if constraint != nil && identifierEquals(constraint.Conname, cmd.Name) {
				changed = true
				continue
			}
			filtered = append(filtered, constraint)
		}
		create.Constraints = filtered
	}
	for _, item := range createTableElements(create) {
		col, ok := item.(*ast.ColumnDef)
		if !ok || col == nil {
			continue
		}
		if removeColumnConstraints(col, func(c *ast.Constraint) bool {
			return identifierEquals(c.Conname, cmd.Name)
		}) {
			changed = true
		}
	}
	if !changed {
		return cmd.MissingOk, false
	}
	return true, true
}

func applyAddIdentity(create *ast.CreateStmt, cmd *ast.AlterTableCmd) (bool, bool) {
	col := findColumnDef(create, cmd.Name)
	if col == nil {
		return false, false
	}
	constraint, ok := cmd.Def.(*ast.Constraint)
	if !ok || constraint == nil || constraint.Contype != ast.CONSTR_IDENTITY {
		return false, false
	}
	if existing := findColumnConstraint(col, func(c *ast.Constraint) bool {
		return c.Contype == ast.CONSTR_IDENTITY
	}); existing != nil {
		if sameNodeSQL(existing, constraint) {
			return true, false
		}
		return false, false
	}
	ensureColumnConstraints(col).Append(constraint)
	return true, true
}

func applySetIdentity(create *ast.CreateStmt, cmd *ast.AlterTableCmd) (bool, bool) {
	col := findColumnDef(create, cmd.Name)
	if col == nil {
		return false, false
	}
	identity := findColumnConstraint(col, func(c *ast.Constraint) bool {
		return c.Contype == ast.CONSTR_IDENTITY
	})
	if identity == nil {
		identity = ast.NewConstraint(ast.CONSTR_IDENTITY)
		identity.GeneratedWhen = ast.ATTRIBUTE_IDENTITY_BY_DEFAULT
		ensureColumnConstraints(col).Append(identity)
	}
	before := canonicalNodeSQL(identity)
	switch v := cmd.Def.(type) {
	case *ast.Constraint:
		if v.Contype != ast.CONSTR_IDENTITY {
			return false, false
		}
		identity.GeneratedWhen = v.GeneratedWhen
		identity.Options = v.Options
	case *ast.NodeList:
		for _, item := range v.Items {
			def, ok := item.(*ast.DefElem)
			if !ok || def == nil {
				continue
			}
			if def.Defname == "generated" {
				if integer, ok := def.Arg.(*ast.Integer); ok {
					switch integer.IVal {
					case int(97): // 'a' => ALWAYS
						identity.GeneratedWhen = ast.ATTRIBUTE_IDENTITY_ALWAYS
					case int(100): // 'd' => BY DEFAULT
						identity.GeneratedWhen = ast.ATTRIBUTE_IDENTITY_BY_DEFAULT
					}
				}
			}
		}
		identity.Options = v
	default:
		return false, false
	}
	after := canonicalNodeSQL(identity)
	return true, before != after
}

func applyDropIdentity(create *ast.CreateStmt, cmd *ast.AlterTableCmd) (bool, bool) {
	col := findColumnDef(create, cmd.Name)
	if col == nil {
		return false, false
	}
	changed := removeColumnConstraints(col, func(c *ast.Constraint) bool {
		return c.Contype == ast.CONSTR_IDENTITY
	})
	return true, changed
}

func findColumnDef(create *ast.CreateStmt, name string) *ast.ColumnDef {
	for _, item := range createTableElements(create) {
		col, ok := item.(*ast.ColumnDef)
		if ok && col != nil && identifierEquals(col.Colname, name) {
			return col
		}
	}
	return nil
}

func createTableElements(create *ast.CreateStmt) []ast.Node {
	if create == nil || create.TableElts == nil {
		return nil
	}
	return create.TableElts.Items
}

func identifierEquals(a, b string) bool {
	return normalizeIdentifier(a) == normalizeIdentifier(b)
}

func ensureColumnConstraints(col *ast.ColumnDef) *ast.NodeList {
	if col.Constraints == nil {
		col.Constraints = ast.NewNodeList()
	}
	return col.Constraints
}

func findColumnConstraint(col *ast.ColumnDef, match func(*ast.Constraint) bool) *ast.Constraint {
	if col == nil || col.Constraints == nil {
		return nil
	}
	for _, item := range col.Constraints.Items {
		constraint, ok := item.(*ast.Constraint)
		if ok && constraint != nil && match(constraint) {
			return constraint
		}
	}
	return nil
}

func columnHasConstraintType(col *ast.ColumnDef, kind ast.ConstrType) bool {
	return findColumnConstraint(col, func(c *ast.Constraint) bool {
		return c.Contype == kind
	}) != nil
}

func removeColumnConstraints(col *ast.ColumnDef, match func(*ast.Constraint) bool) bool {
	if col == nil || col.Constraints == nil || col.Constraints.Len() == 0 {
		return false
	}
	changed := false
	filtered := make([]ast.Node, 0, len(col.Constraints.Items))
	for _, item := range col.Constraints.Items {
		constraint, ok := item.(*ast.Constraint)
		if ok && constraint != nil && match(constraint) {
			changed = true
			continue
		}
		filtered = append(filtered, item)
	}
	if changed {
		col.Constraints.Items = filtered
	}
	return changed
}

func clearColumnDefault(col *ast.ColumnDef) bool {
	changed := false
	if col.RawDefault != nil {
		col.RawDefault = nil
		changed = true
	}
	if removeColumnConstraints(col, func(c *ast.Constraint) bool {
		return c.Contype == ast.CONSTR_DEFAULT
	}) {
		changed = true
	}
	return changed
}

func defaultNodeSQL(col *ast.ColumnDef) string {
	if col == nil {
		return ""
	}
	if col.RawDefault != nil {
		return canonicalNodeSQL(col.RawDefault)
	}
	if constraint := findColumnConstraint(col, func(c *ast.Constraint) bool {
		return c.Contype == ast.CONSTR_DEFAULT
	}); constraint != nil && constraint.RawExpr != nil {
		return canonicalNodeSQL(constraint.RawExpr)
	}
	return ""
}

func canonicalNodeSQL(node ast.Node) string {
	if node == nil {
		return ""
	}
	defer func() {
		_ = recover()
	}()
	return canonicalSQL(node.SqlString())
}

func sameNodeSQL(a, b ast.Node) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return canonicalNodeSQL(a) == canonicalNodeSQL(b)
}

func findConstraint(create *ast.CreateStmt, conname string, exemplar *ast.Constraint) (*ast.Constraint, bool) {
	if len(conname) > 0 {
		for _, constraint := range listTableConstraints(create) {
			if constraint != nil && identifierEquals(constraint.Conname, conname) {
				return constraint, true
			}
		}
		for _, item := range createTableElements(create) {
			col, ok := item.(*ast.ColumnDef)
			if !ok || col == nil {
				continue
			}
			if constraint := findColumnConstraint(col, func(c *ast.Constraint) bool {
				return identifierEquals(c.Conname, conname)
			}); constraint != nil {
				return constraint, true
			}
		}
	}
	if exemplar == nil {
		return nil, false
	}
	for _, constraint := range listTableConstraints(create) {
		if constraint != nil && sameNodeSQL(constraint, exemplar) {
			return constraint, true
		}
	}
	return nil, false
}

func listTableConstraints(create *ast.CreateStmt) []*ast.Constraint {
	result := make([]*ast.Constraint, 0, len(create.Constraints))
	for _, item := range createTableElements(create) {
		if constraint, ok := item.(*ast.Constraint); ok && constraint != nil {
			result = append(result, constraint)
		}
	}
	result = append(result, create.Constraints...)
	return result
}

func samePrimaryKeyConstraint(create *ast.CreateStmt, existing, incoming *ast.Constraint) bool {
	if existing == nil || incoming == nil {
		return false
	}
	if existing.Contype != ast.CONSTR_PRIMARY || incoming.Contype != ast.CONSTR_PRIMARY {
		return false
	}
	incomingCols := primaryKeyColumns(incoming, "")
	if len(incomingCols) == 0 {
		return false
	}
	existingCols := primaryKeyColumns(existing, "")
	if len(existingCols) == 0 {
		existingCols = existingPrimaryColumns(create)
	}
	if len(existingCols) != len(incomingCols) {
		return false
	}
	for i := range existingCols {
		if !identifierEquals(existingCols[i], incomingCols[i]) {
			return false
		}
	}
	return true
}

func existingPrimaryColumns(create *ast.CreateStmt) []string {
	for _, constraint := range listTableConstraints(create) {
		if constraint != nil && constraint.Contype == ast.CONSTR_PRIMARY {
			if cols := primaryKeyColumns(constraint, ""); len(cols) > 0 {
				return cols
			}
		}
	}
	for _, item := range createTableElements(create) {
		col, ok := item.(*ast.ColumnDef)
		if !ok || col == nil {
			continue
		}
		if columnHasConstraintType(col, ast.CONSTR_PRIMARY) {
			return []string{col.Colname}
		}
	}
	return nil
}

func primaryKeyColumns(constraint *ast.Constraint, fallback string) []string {
	if constraint == nil {
		return nil
	}
	if constraint.Keys != nil && constraint.Keys.Len() > 0 {
		cols := make([]string, 0, constraint.Keys.Len())
		for _, item := range constraint.Keys.Items {
			if s, ok := item.(*ast.String); ok {
				cols = append(cols, s.SVal)
			}
		}
		return cols
	}
	if len(fallback) > 0 {
		return []string{fallback}
	}
	return nil
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
	normalized, baseDir := normalizeFunctionRefs(refsList)
	entrypointPrefix := inferEntrypointPrefix(normalized, baseDir)
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
	normalized, baseDir := normalizeFunctionRefs(refsList)
	entrypointPrefix := inferEntrypointPrefix(normalized, baseDir)
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
