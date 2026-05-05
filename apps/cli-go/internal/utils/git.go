package utils

import (
	"os"

	"github.com/go-git/go-git/v5"
	"github.com/spf13/afero"
)

func GetGitBranch(fsys afero.Fs) string {
	return GetGitBranchOrDefault("main", fsys)
}

func GetGitBranchOrDefault(def string, fsys afero.Fs) string {
	head := os.Getenv("GITHUB_HEAD_REF")
	if len(head) > 0 {
		return head
	}
	opts := &git.PlainOpenOptions{DetectDotGit: true}
	if repo, err := git.PlainOpenWithOptions(".", opts); err == nil {
		if ref, err := repo.Head(); err == nil {
			return ref.Name().Short()
		}
	}
	return def
}
