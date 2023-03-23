package utils

import (
	"context"
	"errors"
	"fmt"
	"io"
	"strings"

	"github.com/charmbracelet/bubbles/list"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

var (
	titleStyle        = lipgloss.NewStyle().MarginLeft(2)
	itemStyle         = lipgloss.NewStyle().PaddingLeft(4)
	selectedItemStyle = lipgloss.NewStyle().PaddingLeft(2).Foreground(lipgloss.Color("170"))
	paginationStyle   = list.DefaultStyles().PaginationStyle.PaddingLeft(4)
	helpStyle         = list.DefaultStyles().HelpStyle.PaddingLeft(4).PaddingBottom(1)
)

// PromptItem is exposed as prompt input, empty summary + details will be excluded.
type PromptItem struct {
	Summary string
	Details string
}

func (i PromptItem) Title() string       { return i.Summary }
func (i PromptItem) Description() string { return i.Details }
func (i PromptItem) FilterValue() string { return i.Summary + " " + i.Details }

// Item delegate is used to finetune the list item renderer.
type itemDelegate struct{}

func (d itemDelegate) Height() int                               { return 1 }
func (d itemDelegate) Spacing() int                              { return 0 }
func (d itemDelegate) Update(msg tea.Msg, m *list.Model) tea.Cmd { return nil }
func (d itemDelegate) Render(w io.Writer, m list.Model, index int, listItem list.Item) {
	i, ok := listItem.(PromptItem)
	if !ok {
		return
	}

	str := fmt.Sprintf("%d. %s", index+1, i.Summary)
	if i.Details != "" {
		str += fmt.Sprintf(" [%s]", i.Details)
	}

	fn := itemStyle.Render
	if index == m.Index() {
		fn = func(s ...string) string {
			items := append([]string{"> "}, s...)
			return selectedItemStyle.Render(items...)
		}
	}

	fmt.Fprint(w, fn(str))
}

// Model is used to store state of user choices.
type model struct {
	cancel context.CancelFunc
	list   list.Model
	choice PromptItem
}

func (m model) Init() tea.Cmd {
	return nil
}

func (m model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.list.SetWidth(msg.Width)
		return m, nil

	case tea.KeyMsg:
		switch msg.Type {
		case tea.KeyCtrlC:
			m.cancel()
			return m, tea.Quit

		case tea.KeyEnter:
			choice, ok := m.list.SelectedItem().(PromptItem)
			if ok {
				m.choice = choice
			}
			return m, tea.Quit
		}
	}

	var cmd tea.Cmd
	m.list, cmd = m.list.Update(msg)
	return m, cmd
}

func (m model) View() string {
	if m.choice.Summary != "" {
		return ""
	}
	return "\n" + m.list.View()
}

// Prompt user to choose from a list of items, returns the chosen index.
func PromptChoice(ctx context.Context, title string, items []PromptItem) (PromptItem, error) {
	// Create list items
	var listItems []list.Item
	for _, v := range items {
		if strings.TrimSpace(v.FilterValue()) == "" {
			continue
		}
		listItems = append(listItems, v)
	}
	// Create list model
	height := len(listItems) * 4
	if height > 14 {
		height = 14
	}
	l := list.New(listItems, itemDelegate{}, 0, height)
	l.Title = title
	l.SetShowStatusBar(false)
	l.Styles.Title = titleStyle
	l.Styles.PaginationStyle = paginationStyle
	l.Styles.HelpStyle = helpStyle
	// Create our model
	ctx, cancel := context.WithCancel(ctx)
	initial := model{cancel: cancel, list: l}
	prog := tea.NewProgram(initial)
	state, err := prog.Run()
	if err != nil {
		return initial.choice, err
	}
	if ctx.Err() != nil {
		return initial.choice, ctx.Err()
	}
	if m, ok := state.(model); ok {
		if m.choice == initial.choice {
			return initial.choice, errors.New("user aborted")
		}
		return m.choice, nil
	}
	return initial.choice, err
}
