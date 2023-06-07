package keys

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/go-git/go-git/v5"
	"github.com/golang-jwt/jwt/v5"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
)

type CustomClaims struct {
	Ref  string `json:"ref"`
	Role string `json:"role"`
	jwt.RegisteredClaims
}

func NewJWTToken(ref, role string, expiry time.Time) *jwt.Token {
	claims := CustomClaims{
		ref,
		role,
		jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(expiry),
			Issuer:    "supabase",
		},
	}
	return jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
}

type CustomName struct {
	DbHost         string `env:"db.host,default=NEXT_PUBLIC_SUPABASE_URL"`
	DbPassword     string `env:"db.password,default=SUPABASE_DB_PASSWORD"`
	JWTSecret      string `env:"db.password,default=SUPABASE_AUTH_JWT_SECRET"`
	AnonKey        string `env:"auth.anon_key,default=SUPABASE_AUTH_ANON_KEY"`
	ServiceRoleKey string `env:"auth.service_role_key,default=SUPABASE_AUTH_SERVICE_ROLE_KEY"`
}

func Run(ctx context.Context, projectRef, format string, names CustomName, fsys afero.Fs) error {
	branch := GetGitBranch(fsys)
	if err := GenerateSecrets(ctx, projectRef, branch, fsys); err != nil {
		return err
	}
	return utils.EncodeOutput(format, os.Stdout, map[string]string{
		names.DbHost:         fmt.Sprintf("%s-%s.fly.dev", projectRef, branch),
		names.DbPassword:     utils.Config.Db.Password,
		names.JWTSecret:      utils.Config.Auth.JwtSecret,
		names.AnonKey:        utils.Config.Auth.AnonKey,
		names.ServiceRoleKey: utils.Config.Auth.ServiceRoleKey,
	})
}

func GenerateSecrets(ctx context.Context, projectRef, branch string, fsys afero.Fs) error {
	// Load JWT secret from api
	resp, err := utils.GetSupabase().GetPostgRESTConfigWithResponse(ctx, projectRef)
	if err != nil {
		return err
	}
	if resp.JSON200 == nil {
		return errors.New("Unexpected error retrieving JWT secret: " + string(resp.Body))
	}
	utils.Config.Auth.JwtSecret = *resp.JSON200.JwtSecret
	// Generate database password
	key := strings.Join([]string{
		projectRef,
		utils.Config.Auth.JwtSecret,
		branch,
	}, ":")
	hash := sha256.Sum256([]byte(key))
	utils.Config.Db.Password = hex.EncodeToString(hash[:])
	// Generate JWT tokens
	expiry := time.Now().AddDate(10, 0, 0)
	anonToken := NewJWTToken(projectRef, "anon", expiry)
	utils.Config.Auth.AnonKey, err = anonToken.SignedString([]byte(utils.Config.Auth.JwtSecret))
	if err != nil {
		return err
	}
	serviceToken := NewJWTToken(projectRef, "service_role", expiry)
	utils.Config.Auth.ServiceRoleKey, err = serviceToken.SignedString([]byte(utils.Config.Auth.JwtSecret))
	return err
}

func GetGitBranch(fsys afero.Fs) string {
	head := os.Getenv("GITHUB_HEAD_REF")
	if len(head) > 0 {
		return head
	}
	branch := "main"
	opts := &git.PlainOpenOptions{DetectDotGit: true}
	if repo, err := git.PlainOpenWithOptions(".", opts); err == nil {
		if ref, err := repo.Head(); err == nil {
			branch = ref.Name().Short()
		}
	}
	return branch
}
