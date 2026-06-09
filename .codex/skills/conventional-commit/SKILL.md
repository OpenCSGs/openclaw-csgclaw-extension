---
name: conventional-commit
description: Draft Conventional Commit messages from the current git changes in a local repository. Use when an agent should inspect staged or unstaged diffs, infer the primary change, suggest one or more commit messages, and warn when the changes should be split into multiple commits.
---

# Conventional Commit

Generate Conventional Commit style commit messages from the current repository changes. Prefer the actual git diff over the user's summary.

Default behavior is suggestion-only. If the user explicitly asks to commit, first generate the message options, then execute the commit only after the user approves the action.

## Workflow

1. Resolve the repository path.
If the user does not specify one, use the current working tree.

2. Collect change context with the helper script.
Run:

```bash
python3 .codex/skills/conventional-commit/scripts/collect_git_changes.py --repo /path/to/repo
```

By default, the script prefers staged changes. If nothing is staged, it falls back to tracked working tree changes only. Untracked files are excluded unless explicitly requested.

Useful overrides:

```bash
python3 .codex/skills/conventional-commit/scripts/collect_git_changes.py --repo /path/to/repo --mode staged
python3 .codex/skills/conventional-commit/scripts/collect_git_changes.py --repo /path/to/repo --mode worktree
python3 .codex/skills/conventional-commit/scripts/collect_git_changes.py --repo /path/to/repo --mode worktree --include-untracked
```

3. Read the emitted summary and patch.
Use the helper output as the source of truth for changed files, diff stats, and patch details.

4. Infer the commit shape.
Choose the best Conventional Commit `type`, an optional `scope`, and a concise imperative subject.

5. Return commit message suggestions.
Default to 3 options unless the user asks for only 1. Mark one option as recommended.

6. If the user asked to commit, prepare the recommended message for approval.
Do not auto-commit without explicit user request.

7. Flag mixed changes.
If the diff clearly contains unrelated work, say so and recommend splitting the commit instead of forcing a misleading single message.

## Commit Execution

- Only commit when the user explicitly asks for it.
- Prefer staged changes for commit mode. If nothing is staged, do not auto-stage files unless the user asked to stage all changes.
- Before commit, ensure there are staged changes.
- If the diff appears mixed or too broad, do not commit automatically; recommend splitting instead.
- Prefer the helper script for execution:

```bash
python3 .codex/skills/conventional-commit/scripts/apply_commit.py --repo /path/to/repo --message "type(scope): subject"
```

For a body:

```bash
python3 .codex/skills/conventional-commit/scripts/apply_commit.py --repo /path/to/repo --message "type(scope): subject" --body "first line\nsecond line"
```

## Agent Attribution Rules (CRITICAL)

- Never add `Co-authored-by`, `Signed-off-by`, or any agent/tool attribution trailer.
- Never add Cursor, Codex, Claude, Copilot, or similar agent markers to commit messages.
- Do not override git author or committer identity unless the user explicitly requests it.
- Use plain `git commit -m` / `apply_commit.py` only; keep the commit attributed to the repository user.

## Type Selection

Use these types:

- `feat`: new user-facing or developer-facing functionality
- `fix`: bug fix or behavior correction
- `docs`: documentation-only change
- `style`: formatting or non-behavioral code style cleanup
- `refactor`: structural improvement without behavior change
- `perf`: performance improvement
- `test`: new or updated tests
- `build`: build tooling, dependencies affecting build, packaging
- `ci`: CI or automation workflow changes
- `chore`: maintenance work that does not fit the above
- `revert`: reverting a prior commit

Prefer the narrowest accurate type. Do not use `feat` for internal cleanup that does not add capability.

## Scope Rules

- Scope is optional.
- Prefer a short subsystem or top-level area such as `cli`, `config`, `api`, `web`, `docker`, or `ci`.
- Omit the scope when the diff spans multiple unrelated areas or no clear scope exists.

## Subject Rules

- Use imperative mood: `add`, `fix`, `update`, `remove`.
- Keep the subject line concise and specific.
- Avoid ending the subject with a period.
- Avoid vague summaries like `update files` or `fix issues`.
- Mention the outcome, not the implementation detail, when possible.

## Body Rules

- Add a body only when it materially improves clarity.
- Use the body for rationale, notable side effects, or grouped subchanges.
- Mention breaking changes explicitly when they are real.
- Never append agent attribution lines to the body.

## Output Format

Use this format unless the user asks for something else:

```md
Recommended:
`type(scope): subject`

Alternatives:
1. `type(scope): subject`
2. `type(scope): subject`

Why:
- ...
- ...
```

If a body is warranted, include a complete multi-line commit message in a fenced block.

If the user also asked to commit, present the recommendation first, then run the approved commit command.

## Failure Handling

- If there are no changes, say that no commit message can be generated yet.
- If the repository is not a git worktree, report that clearly.
- If the diff is too broad to summarize honestly in one commit, recommend splitting it and suggest candidate messages per split if possible.
- If the user asked to commit but there are no staged changes, explain that no commit was run.

## Example Prompt

`Use $conventional-commit to generate commit messages from the current repo changes.`

`Use $conventional-commit to generate commit messages and commit the staged changes with the recommended message.`
