package main

import (
	"fmt"
	"log"
	"strings"

	"github.com/spf13/cobra"
	"github.com/supabase/cli/cmd"
	"gopkg.in/yaml.v2"
)

func main() {
	root := cmd.GetRootCmd()
	root.InitDefaultHelpCmd()
	root.InitDefaultHelpFlag()
	spec := SpecDoc{
		Clispec: "001",
		Info: InfoDoc{
			Id:          "cli",
			Version:     "1.0.0",
			Title:       "Supabase CLI",
			Language:    "sh",
			Source:      "https://github.com/supabase/cli",
			Bugs:        "https://github.com/supabase/cli/issues",
			Spec:        "https://github.com/supabase/supabase.tools/cli_spec/lib.yaml",
			Description: root.Short,
			Options:     mdScriptEscape(root.Flags().FlagUsages()),
		},
	}
	// Generate, serialise, and print
	_ = GenYamlDoc(root, &spec)
	for i, j := 0, len(spec.Commands)-1; i < j; i, j = i+1, j-1 {
		spec.Commands[i], spec.Commands[j] = spec.Commands[j], spec.Commands[i]
	}

	final, err := yaml.Marshal(spec)
	if err != nil {
		log.Fatalln(err)
	}
	if _, err := fmt.Println(string(final)); err != nil {
		log.Fatalln(err)
	}
}

type InfoDoc struct {
	Id          string `yaml:",omitempty"`
	Version     string `yaml:",omitempty"`
	Title       string `yaml:",omitempty"`
	Language    string `yaml:",omitempty"`
	Source      string `yaml:",omitempty"`
	Bugs        string `yaml:",omitempty"`
	Spec        string `yaml:",omitempty"`
	Description string `yaml:",omitempty"`
	Options     string `yaml:",omitempty"`
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

func GenYamlDoc(cmd *cobra.Command, root *SpecDoc) CmdDoc {
	var subcommands []string
	for _, c := range cmd.Commands() {
		if !c.IsAvailableCommand() || c.IsAdditionalHelpTopicCommand() {
			continue
		}
		sub := GenYamlDoc(c, root)
		root.Commands = append(root.Commands, sub)
		subcommands = append(subcommands, sub.Id)
	}

	cmd.InitDefaultHelpCmd()
	cmd.InitDefaultHelpFlag()

	yamlDoc := CmdDoc{
		Id:          strings.ReplaceAll(cmd.CommandPath(), " ", "-"),
		Title:       cmd.CommandPath(),
		Summary:     forceMultiLine(cmd.Short),
		Description: forceMultiLine(cmd.Long),
		Subcommands: subcommands,
	}

	if cmd.Runnable() {
		yamlDoc.Usage = mdScriptEscape(cmd.UseLine())
	}

	flags := cmd.NonInheritedFlags()
	if flags.HasFlags() {
		yamlDoc.Options = mdScriptEscape(flags.FlagUsages())
	}

	return yamlDoc
}

func mdScriptEscape(script string) string {
	return "```sh\n" + strings.Trim(script, "\n") + "\n```"
}

// Temporary workaround for yaml lib generating incorrect yaml with long strings
// that do not contain \n.
func forceMultiLine(s string) string {
	if len(s) > 60 && !strings.Contains(s, "\n") {
		s = s + "\n"
	}
	return s
}
