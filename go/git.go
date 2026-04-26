// Git context — INARIWATCH_GIT_* env vars (build-time fast path) with
// subprocess `git` fallback cached once per process.
package capture

import (
	"context"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"sync"
	"time"
)

var (
	gitOnce  sync.Once
	gitCache *GitContext
)

func runGit(args ...string) string {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "git", args...).Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

var (
	msgSecretPattern  = regexp.MustCompile(`(?i)(?:sk|pk|api|key|token|secret|password)[_-]?\S{8,}`)
	msgConnectionPattern = regexp.MustCompile(`://[^:]+:[^@]+@`)
)

func scrubCommitMessage(msg string) string {
	out := msgSecretPattern.ReplaceAllString(msg, "[REDACTED]")
	out = msgConnectionPattern.ReplaceAllString(out, "://[REDACTED]@")
	return out
}

func fromEnv() *GitContext {
	commit := os.Getenv("INARIWATCH_GIT_COMMIT")
	if commit == "" {
		return nil
	}
	return &GitContext{
		Commit:    commit,
		Branch:    envOr("INARIWATCH_GIT_BRANCH", "unknown"),
		Message:   os.Getenv("INARIWATCH_GIT_MESSAGE"),
		Timestamp: os.Getenv("INARIWATCH_GIT_TIMESTAMP"),
		Dirty:     os.Getenv("INARIWATCH_GIT_DIRTY") == "true",
	}
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func fromSubprocess() *GitContext {
	commit := runGit("rev-parse", "HEAD")
	if commit == "" {
		return nil
	}
	branch := runGit("rev-parse", "--abbrev-ref", "HEAD")
	if branch == "" {
		branch = "unknown"
	}
	msg := scrubCommitMessage(runGit("log", "-1", "--format=%s"))
	if len(msg) > 200 {
		msg = msg[:200]
	}
	dirty := runGit("status", "--porcelain") != ""
	return &GitContext{
		Commit:    commit,
		Branch:    branch,
		Message:   msg,
		Timestamp: runGit("log", "-1", "--format=%cI"),
		Dirty:     dirty,
	}
}

// GetGitContext returns build-time git metadata. Env vars take
// precedence; otherwise ``git`` is spawned once and the result cached.
func GetGitContext() *GitContext {
	gitOnce.Do(func() {
		if g := fromEnv(); g != nil {
			gitCache = g
			return
		}
		gitCache = fromSubprocess()
	})
	return gitCache
}
