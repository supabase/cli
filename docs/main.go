package main

import (
	"bytes"
	"embed"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"

	"github.com/go-errors/errors"
	"github.com/go-viper/mapstructure/v2"
	"github.com/spf13/cobra"
	"github.com/spf13/pflag"
	"github.com/spf13/viper"
	cli "github.com/supabase/cli/cmd"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/config"
	"gopkg.in/yaml.v3"
)

const (
	srcCommand = "command"
	srcConfig  = "config"
)

func main() {
	target := utils.EnumFlag{
		Allowed: []string{
			srcCommand,
			srcConfig,
		},
		Value: srcCommand,
	}
	pflag.VarP(&target, "target", "t", "target document to generate")
	pflag.Parse()
	// Parse cli args
	semver := "latest"
	if arg := pflag.Arg(0); len(arg) > 0 {
		semver = strings.TrimPrefix(arg, "v")
	}
	if err := generate(semver, target.Value); err != nil {
		log.Fatalln(err)
	}
}

func generate(version, target string) error {
	switch target {
	case srcCommand:
		return writeCommandSpec(version, os.Stdout)
	case srcConfig:
		return writeConfigSpec(version, os.Stdout)
	}
	return errors.Errorf("unsupported target document: %s", target)
}

type ConfigDoc struct {
	Configspec string     `yaml:",omitempty"`
	Info       InfoDoc    `yaml:",omitempty"`
	Parameters []ParamDoc `yaml:",omitempty"`
}

type ParamDoc struct {
	Id          string    `yaml:",omitempty"`
	Title       string    `yaml:",omitempty"`
	Description string    `yaml:",omitempty"`
	Required    bool      `yaml:",omitempty"`
	Default     string    `yaml:",omitempty"`
	Tags        []string  `yaml:",omitempty"`
	Links       []LinkDoc `yaml:""`
}

func writeConfigSpec(version string, w io.Writer) error {
	spec := ConfigDoc{
		Configspec: "001",
		Info: InfoDoc{
			Id:          "cli",
			Version:     version,
			Title:       "CLI",
			Description: "A `supabase/config.toml` file is generated after running `supabase init`.\n\nYou can edit this file to change the settings for your locally running project. After you make changes, you will need to restart using `supabase stop` and then `supabase start` for the changes to take effect.",
			Source:      "https://github.com/supabase/cli",
			Bugs:        "https://github.com/supabase/cli/issues",
			Spec:        "https://github.com/supabase/supabase/apps/docs/spec/cli_v1_config.yaml",
			Tags: []TagDoc{{
				Id:          "general",
				Title:       "General",
				Description: "General settings.",
			}},
		},
	}
	// Load default values
	v := viper.New()
	if err := loadDefaultValues(v); err != nil {
		return err
	}
	exists := map[string]struct{}{}
	for _, k := range v.AllKeys() {
		tag := spec.Info.Tags[0].Id
		if i := strings.IndexByte(k, '.'); i > 0 {
			tag = k[:i]
			exists[tag] = struct{}{}
		}
		// Secret struct is marshalled from string
		id := strings.TrimSuffix(k, "."+secretKey)
		spec.Parameters = append(spec.Parameters, ParamDoc{
			Id:       id,
			Title:    id,
			Tags:     []string{tag},
			Required: false,
			Default:  v.GetString(k),
		})
	}
	sort.Slice(spec.Parameters, func(i, j int) bool {
		return spec.Parameters[i].Id < spec.Parameters[j].Id
	})
	for k := range exists {
		spec.Info.Tags = append(spec.Info.Tags, TagDoc{
			Id:          k,
			Title:       k,
			Description: fmt.Sprintf("%s settings.", k),
		})
		// fmt.Fprintln(os.Stderr, k)
	}
	// Write to stdout
	encoder := yaml.NewEncoder(w)
	encoder.SetIndent(2)
	return encoder.Encode(spec)
}

func loadDefaultValues(v *viper.Viper) error {
	if err := utils.Config.Load("", embed.FS{}); err != nil {
		return err
	}
	base, _ := utils.Config.GetRemoteByProjectRef("")
	var result map[string]any
	if dec, err := mapstructure.NewDecoder(&mapstructure.DecoderConfig{
		TagName:    "toml",
		Squash:     true,
		ZeroFields: true,
		Result:     &result,
		DecodeHook: mapstructure.ComposeDecodeHookFunc(
			decodeSecret,
			decodeBuckets,
		),
	}); err != nil {
		return errors.Errorf("failed to init decoder: %w", err)
	} else if err := dec.Decode(base); err != nil {
		return errors.Errorf("failed to decode config: %w", err)
	}
	if err := v.MergeConfigMap(result); err != nil {
		return errors.Errorf("failed to merge config: %w", err)
	}
	return nil
}

const secretKey = "secret"

func decodeSecret(f reflect.Kind, t reflect.Kind, data any) (any, error) {
	if secret, ok := data.(*config.Secret); ok {
		return map[string]string{secretKey: secret.Value}, nil
	}
	return data, nil
}

func decodeBuckets(f reflect.Type, t reflect.Type, data any) (any, error) {
	// TODO: handle links and empty map
	if f.Kind() != reflect.Map {
		return data, nil
	}
	fmt.Fprintf(os.Stderr, "%v\n", data)
	// if buckets, ok := data.(map[string]any); ok {
	// 	fmt.Fprintln(os.Stderr, "buckets:", len(buckets))
	// }
	return data, nil
}

type TagDoc struct {
	Id          string `yaml:",omitempty"`
	Title       string `yaml:",omitempty"`
	Description string `yaml:",omitempty"`
}

type InfoDoc struct {
	Id          string   `yaml:",omitempty"`
	Version     string   `yaml:",omitempty"`
	Title       string   `yaml:",omitempty"`
	Language    string   `yaml:",omitempty"`
	Source      string   `yaml:",omitempty"`
	Bugs        string   `yaml:",omitempty"`
	Spec        string   `yaml:",omitempty"`
	Description string   `yaml:",omitempty"`
	Options     string   `yaml:",omitempty"`
	Tags        []TagDoc `yaml:",omitempty"`
}

type ValueDoc struct {
	Id          string `yaml:",omitempty"`
	Name        string `yaml:",omitempty"`
	Type        string `yaml:",omitempty"`
	Description string `yaml:",omitempty"`
}

type FlagDoc struct {
	Id             string     `yaml:",omitempty"`
	Name           string     `yaml:",omitempty"`
	Description    string     `yaml:",omitempty"`
	Required       bool       `yaml:",omitempty"`
	DefaultValue   string     `yaml:"default_value"`
	AcceptedValues []ValueDoc `yaml:"accepted_values,omitempty"`
}

type ExampleDoc struct {
	Id       string `yaml:",omitempty"`
	Name     string `yaml:",omitempty"`
	Code     string `yaml:",omitempty"`
	Response string `yaml:",omitempty"`
}

type CmdDoc struct {
	Id          string       `yaml:",omitempty"`
	Title       string       `yaml:",omitempty"`
	Summary     string       `yaml:",omitempty"`
	Source      string       `yaml:",omitempty"`
	Description string       `yaml:",omitempty"`
	Examples    []ExampleDoc `yaml:",omitempty"`
	Tags        []string     `yaml:""`
	Links       []LinkDoc    `yaml:""`
	Usage       string       `yaml:",omitempty"`
	Subcommands []string     `yaml:""`
	Options     string       `yaml:",omitempty"`
	Flags       []FlagDoc    `yaml:""`
}

type LinkDoc struct {
	Name string `yaml:",omitempty"`
	Link string `yaml:",omitempty"`
}

type SpecDoc struct {
	Clispec    string    `yaml:",omitempty"`
	Info       InfoDoc   `yaml:",omitempty"`
	Flags      []FlagDoc `yaml:",omitempty"`
	Commands   []CmdDoc  `yaml:",omitempty"`
	Parameters []FlagDoc `yaml:",omitempty"`
}

const tagOthers = "other-commands"

var (
	examples map[string][]ExampleDoc
	//go:embed templates/examples.yaml
	exampleSpec string
	//go:embed supabase/*
	docsDir embed.FS
)

func writeCommandSpec(version string, w io.Writer) error {
	dec := yaml.NewDecoder(strings.NewReader(exampleSpec))
	if err := dec.Decode(&examples); err != nil {
		return err
	}
	root := cli.GetRootCmd()
	root.InitDefaultCompletionCmd()
	root.InitDefaultHelpFlag()
	spec := SpecDoc{
		Clispec: "001",
		Info: InfoDoc{
			Id:          "cli",
			Version:     version,
			Title:       strings.TrimSpace(root.Short),
			Description: forceMultiLine("Supabase CLI provides you with tools to develop your application locally, and deploy your application to the Supabase platform."),
			Language:    "sh",
			Source:      "https://github.com/supabase/cli",
			Bugs:        "https://github.com/supabase/cli/issues",
			Spec:        "https://github.com/supabase/supabase/apps/docs/spec/cli_v1_commands.yaml",
			Tags:        getTags(root),
		},
	}
	root.Flags().VisitAll(func(flag *pflag.Flag) {
		if !flag.Hidden {
			spec.Flags = append(spec.Flags, getFlags(flag))
		}
	})
	if err := root.MarkFlagRequired("experimental"); err != nil {
		return err
	}
	// Generate, serialise, and print
	yamlDoc := GenYamlDoc(root, &spec)
	spec.Info.Options = yamlDoc.Options
	// Reverse commands list
	for i, j := 0, len(spec.Commands)-1; i < j; i, j = i+1, j-1 {
		spec.Commands[i], spec.Commands[j] = spec.Commands[j], spec.Commands[i]
	}
	// Write to stdout
	encoder := yaml.NewEncoder(w)
	encoder.SetIndent(2)
	return encoder.Encode(spec)
}

// DFS on command tree to generate documentation specs.
func GenYamlDoc(cmd *cobra.Command, root *SpecDoc) CmdDoc {
	var subcommands []string
	for _, c := range cmd.Commands() {
		if !c.IsAvailableCommand() || c.IsAdditionalHelpTopicCommand() {
			continue
		}
		sub := GenYamlDoc(c, root)
		if !cmd.HasParent() && len(sub.Tags) == 0 {
			sub.Tags = append(sub.Tags, tagOthers)
		}
		root.Commands = append(root.Commands, sub)
		subcommands = append(subcommands, sub.Id)
	}

	yamlDoc := CmdDoc{
		Id:          strings.ReplaceAll(cmd.CommandPath(), " ", "-"),
		Title:       cmd.CommandPath(),
		Summary:     forceMultiLine(cmd.Short),
		Description: forceMultiLine(strings.ReplaceAll(cmd.Long, "\t", "    ")),
		Subcommands: subcommands,
	}

	names := strings.Fields(cmd.CommandPath())
	if len(names) > 3 {
		base := strings.Join(names[2:], "-")
		names = append(names[:2], base)
	}
	path := filepath.Join(names...) + ".md"
	if contents, err := docsDir.ReadFile(path); err == nil {
		noHeader := bytes.TrimLeftFunc(contents, func(r rune) bool {
			return r != '\n'
		})
		yamlDoc.Description = forceMultiLine(string(noHeader))
	}

	if eg, ok := examples[yamlDoc.Id]; ok {
		yamlDoc.Examples = eg
	}

	if len(cmd.GroupID) > 0 {
		yamlDoc.Tags = append(yamlDoc.Tags, cmd.GroupID)
	}

	if cmd.Runnable() {
		yamlDoc.Usage = forceMultiLine(cmd.UseLine())
	}

	// Only print flags for root and leaf commands
	if !cmd.HasSubCommands() {
		flags := cmd.LocalFlags()
		flags.VisitAll(func(flag *pflag.Flag) {
			if !flag.Hidden {
				yamlDoc.Flags = append(yamlDoc.Flags, getFlags(flag))
			}
		})
		// Print required flag for experimental commands
		globalFlags := cmd.Root().Flags()
		if cli.IsExperimental(cmd) {
			flag := globalFlags.Lookup("experimental")
			yamlDoc.Flags = append(yamlDoc.Flags, getFlags(flag))
		}
		// Leaf commands should inherit parent flags except root
		parentFlags := cmd.InheritedFlags()
		parentFlags.VisitAll(func(flag *pflag.Flag) {
			if !flag.Hidden && globalFlags.Lookup(flag.Name) == nil {
				yamlDoc.Flags = append(yamlDoc.Flags, getFlags(flag))
			}
		})
	}

	return yamlDoc
}

func getFlags(flag *pflag.Flag) FlagDoc {
	doc := FlagDoc{
		Id:           flag.Name,
		Name:         getName(flag),
		Description:  forceMultiLine(getUsage(flag)),
		DefaultValue: flag.DefValue,
		Required:     flag.Annotations[cobra.BashCompOneRequiredFlag] != nil,
	}
	if f, ok := flag.Value.(*utils.EnumFlag); ok {
		for _, v := range f.Allowed {
			doc.AcceptedValues = append(doc.AcceptedValues, ValueDoc{
				Id:   v,
				Name: v,
				Type: flag.Value.Type(),
			})
		}
	}
	return doc
}

// Prints a human readable flag name.
//
//	-f, --flag `string`
func getName(flag *pflag.Flag) (line string) {
	// Prefix: shorthand
	if flag.Shorthand != "" && flag.ShorthandDeprecated == "" {
		line += fmt.Sprintf("-%s, ", flag.Shorthand)
	}
	line += fmt.Sprintf("--%s", flag.Name)
	// Suffix: type
	if varname, _ := pflag.UnquoteUsage(flag); varname != "" {
		line += fmt.Sprintf(" <%s>", varname)
	}
	// Not used by our cmd but kept here for consistency
	if flag.NoOptDefVal != "" {
		switch flag.Value.Type() {
		case "string":
			line += fmt.Sprintf("[=\"%s\"]", flag.NoOptDefVal)
		case "bool":
			if flag.NoOptDefVal != "true" {
				line += fmt.Sprintf("[=%s]", flag.NoOptDefVal)
			}
		case "count":
			if flag.NoOptDefVal != "+1" {
				line += fmt.Sprintf("[=%s]", flag.NoOptDefVal)
			}
		default:
			line += fmt.Sprintf("[=%s]", flag.NoOptDefVal)
		}
	}
	return line
}

// Prints flag usage and default value.
//
//	Select a plan. (default "free")
func getUsage(flag *pflag.Flag) string {
	_, usage := pflag.UnquoteUsage(flag)
	return usage
}

// Yaml lib generates incorrect yaml with long strings that do not contain \n.
//
//	example: 'a a a a a a a a a a a a a a a a a a a a a a a a a a a a a a a a a a a
//	  a a a a a a '
func forceMultiLine(s string) string {
	if len(s) > 60 && !strings.Contains(s, "\n") {
		s = s + "\n"
	}
	return s
}

func getTags(cmd *cobra.Command) (tags []TagDoc) {
	for _, group := range cmd.Groups() {
		tags = append(tags, TagDoc{
			Id:    group.ID,
			Title: group.Title[:len(group.Title)-1],
		})
	}
	tags = append(tags, TagDoc{Id: tagOthers, Title: "Additional Commands"})
	return tags
}

func decodeComment(f reflect.Type, t reflect.Type, data any) (any, error) {
	if f.Kind() == reflect.Pointer {
		f = f.Elem()
	}
	if f.Kind() != reflect.Struct {
		return data, nil
	}
	r := map[string]any{}
	for i := 0; i < f.NumField(); i++ {
		field := f.Field(i)
		k := field.Tag.Get("toml")
		if v := field.Tag.Get("comment"); len(v) > 0 {
			r[k] = v
			fmt.Fprintf(os.Stderr, "%d. %v (%v), tag: '%v'\n", i+1, field.Name, k, v)
		}
	}
	if len(r) > 0 {
		return r, nil
	}
	return data, nil
}
