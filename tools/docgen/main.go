package main

import (
	"log"
	"os"
	"strings"

	"github.com/spf13/cobra"
	"github.com/supabase/cli/cmd"
	"gopkg.in/yaml.v2"
)

const tagOthers = "other-commands"

func main() {
	root := cmd.GetRootCmd()
	root.InitDefaultCompletionCmd()
	spec := SpecDoc{
		Clispec: "001",
		Info: InfoDoc{
			Id:          "cli",
			Version:     "1.11.3",
			Title:       strings.TrimSpace(root.Short),
			Description: forceMultiLine("Supabase CLI provides you with tools to develop your application locally, and deploy your application to the Supabase platform."),
			Language:    "sh",
			Source:      "https://github.com/supabase/cli",
			Bugs:        "https://github.com/supabase/cli/issues",
			Spec:        "https://github.com/supabase/supabase.tools/cli_spec/lib.yaml",
			Tags:        getTags(root),
		},
	}
	// Generate, serialise, and print
	yamlDoc := GenYamlDoc(root, &spec)
	spec.Info.Options = yamlDoc.Options
	// Reverse commands list
	for i, j := 0, len(spec.Commands)-1; i < j; i, j = i+1, j-1 {
		spec.Commands[i], spec.Commands[j] = spec.Commands[j], spec.Commands[i]
	}
	// Write to stdout
	encoder := yaml.NewEncoder(os.Stdout)
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

type CmdDoc struct {
	Id          string   `yaml:",omitempty"`
	Title       string   `yaml:",omitempty"`
	Summary     string   `yaml:",omitempty"`
	Source      string   `yaml:",omitempty"`
	Description string   `yaml:",omitempty"`
	Tags        []string `yaml:""`
	Links       []string `yaml:""`
	Usage       string   `yaml:",omitempty"`
	Subcommands []string `yaml:""`
	Options     string   `yaml:",omitempty"`
}

type SpecDoc struct {
	Clispec  string   `yaml:",omitempty"`
	Info     InfoDoc  `yaml:",omitempty"`
	Commands []CmdDoc `yaml:""`
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

	cmd.InitDefaultHelpCmd()
	cmd.InitDefaultHelpFlag()

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
		yamlDoc.Usage = mdCodeBlock(cmd.UseLine(), root.Info.Language)
	}

	flags := cmd.NonInheritedFlags()
	if flags.HasFlags() {
		yamlDoc.Options = mdCodeBlock(flags.FlagUsages(), root.Info.Language)
	}

	return yamlDoc
}

// Wraps a command string in markdown style code block, ie.
//
//	```sh
//	echo "hello world"
//	```
func mdCodeBlock(script string, language string) string {
	return "```" + language + "\n" + strings.Trim(script, "\n") + "\n```"
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
