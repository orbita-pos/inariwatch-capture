//! Git context — `INARIWATCH_GIT_*` env vars first, subprocess fallback
//! cached once per process. Same naming convention as Node/Python/Go.

use crate::types::GitContext;
use parking_lot::Mutex;
use std::process::Command;

static CACHE: once_cell::sync::Lazy<Mutex<Option<Option<GitContext>>>> =
    once_cell::sync::Lazy::new(|| Mutex::new(None));

pub fn get_git_context() -> Option<GitContext> {
    {
        let g = CACHE.lock();
        if let Some(cached) = g.as_ref() {
            return cached.clone();
        }
    }

    // Env-var fast path.
    let from_env = GitContext {
        commit: std::env::var("INARIWATCH_GIT_COMMIT").ok(),
        branch: std::env::var("INARIWATCH_GIT_BRANCH").ok(),
        repo: std::env::var("INARIWATCH_GIT_REPO").ok(),
        message: std::env::var("INARIWATCH_GIT_MESSAGE").ok(),
        author: std::env::var("INARIWATCH_GIT_AUTHOR").ok(),
    };
    if from_env.commit.is_some() || from_env.branch.is_some() {
        let mut g = CACHE.lock();
        *g = Some(Some(from_env.clone()));
        return Some(from_env);
    }

    // Subprocess fallback — best-effort, swallow all failures.
    let out = (|| {
        let commit = run_git(&["rev-parse", "HEAD"])?;
        let branch = run_git(&["rev-parse", "--abbrev-ref", "HEAD"]).unwrap_or_default();
        let message = run_git(&["log", "-1", "--pretty=%s"]).unwrap_or_default();
        let author = run_git(&["log", "-1", "--pretty=%an"]).unwrap_or_default();
        Some(GitContext {
            commit: Some(commit),
            branch: if branch.is_empty() { None } else { Some(branch) },
            repo: None,
            message: if message.is_empty() { None } else { Some(message) },
            author: if author.is_empty() { None } else { Some(author) },
        })
    })();

    let mut g = CACHE.lock();
    *g = Some(out.clone());
    out
}

fn run_git(args: &[&str]) -> Option<String> {
    let output = Command::new("git").args(args).output().ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
}
