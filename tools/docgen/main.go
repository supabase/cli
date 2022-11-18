package main

import (
	"fmt"
	"log"
	"os"
	"strings"

	"github.com/spf13/cobra"
	"github.com/spf13/pflag"
	"github.com/supabase/cli/cmd"
	"github.com/supabase/cli/internal/utils"
	"gopkg.in/yaml.v3"
)

const tagOthers = "other-commands"

func main() {
	root := cmd.GetRootCmd()
	root.InitDefaultCompletionCmd()
	root.InitDefaultHelpFlag()
	spec := SpecDoc{
		Clispec: "001",
		Info: InfoDoc{
			Id:          "cli",
			Version:     "1.14.3",
			Title:       strings.TrimSpace(root.Short),
			Description: forceMultiLine("Supabase CLI provides you with tools to develop your application locally, and deploy your application to the Supabase platform."),
			Language:    "sh",
			Source:      "https://github.com/supabase/cli",
			Bugs:        "https://github.com/supabase/cli/issues",
			Spec:        "https://github.com/supabase/supabase.tools/cli_spec/lib.yaml",
			Tags:        getTags(root),
		},
	}
	root.Flags().VisitAll(func(flag *pflag.Flag) {
		if !flag.Hidden {
			spec.Flags = append(spec.Flags, getFlags(flag))
		}
	})
	// Generate, serialise, and print
	yamlDoc := GenYamlDoc(root, &spec)
	spec.Info.Options = yamlDoc.Options
	// Reverse commands list
	for i, j := 0, len(spec.Commands)-1; i < j; i, j = i+1, j-1 {
		spec.Commands[i], spec.Commands[j] = spec.Commands[j], spec.Commands[i]
	}
	// Write to stdout
	encoder := yaml.NewEncoder(os.Stdout)
	encoder.SetIndent(2)
	if err := encoder.Encode(spec); err != nil {
		log.Fatalln(err)
	}
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

type CmdDoc struct {
	Id          string    `yaml:",omitempty"`
	Title       string    `yaml:",omitempty"`
	Summary     string    `yaml:",omitempty"`
	Source      string    `yaml:",omitempty"`
	Description string    `yaml:",omitempty"`
	Tags        []string  `yaml:""`
	Links       []string  `yaml:""`
	Usage       string    `yaml:",omitempty"`
	Subcommands []string  `yaml:""`
	Options     string    `yaml:",omitempty"`
	Flags       []FlagDoc `yaml:""`
}

type SpecDoc struct {
	Clispec  string    `yaml:",omitempty"`
	Info     InfoDoc   `yaml:",omitempty"`
	Flags    []FlagDoc `yaml:",omitempty"`
	Commands []CmdDoc  `yaml:""`
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

	if len(cmd.GroupID) > 0 {
		yamlDoc.Tags = append(yamlDoc.Tags, cmd.GroupID)
	}

	if cmd.Runnable() {
		yamlDoc.Usage = forceMultiLine(cmd.UseLine())
	}

	flags := cmd.NonInheritedFlags()
	flags.VisitAll(func(flag *pflag.Flag) {
		if !flag.Hidden {
			yamlDoc.Flags = append(yamlDoc.Flags, getFlags(flag))
		}
	})

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
