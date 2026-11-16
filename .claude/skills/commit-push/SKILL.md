---
name: commit-push
description: Commit all current changes and push them straight to main.
---

Commit the current changes and push to `main` without asking for confirmation.

1. Run `git status` and `git diff` to see what changed, and `git log -3` to match the message style.
2. Stage the changes (leave out secrets and gitignored files), and commit with a clear imperative message ending with the attribution line from the session's system-reminder.
3. Run `git push origin main`. Never force-push.
4. Report the commit hash and summary.
