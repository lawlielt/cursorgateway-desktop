# gitlab-mr-reviewer

Review a GitLab Merge Request and post issues as **separate MR comments**.

## Scope (MVP)
- Input: GitLab MR URL
- Analyze MR diff with deterministic heuristics
- Post one comment per finding
- Deduplicate repeated findings via signature hash
- No code changes, no commits

## Requirements
- Node.js 18+
- `GITLAB_TOKEN` with API scope

## Usage

```bash
export GITLAB_TOKEN=glpat-xxxx
node tools/gitlab-mr-reviewer/review-mr.mjs "https://gitlab.example.com/group/proj/-/merge_requests/123"
```

## Current checks
- Debug statements in added lines (`console.log`, `debugger`)
- TODO/FIXME/HACK markers
- Risky-path reminders (auth/billing/token/payment/security-related files)

## Notes
- This MVP posts general MR notes (not inline threaded discussions).
- Can be extended to LLM-based review and inline position comments later.
