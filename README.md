# pr-review-digest

One terminal view of where you stand on every open pull request: what needs you, what you
opened, and what you can forget about. Reads GitHub and nothing else.

No server, no npm dependencies, no stored credentials.

```
PR review digest — 7 open PRs, as you

Needs you (3)
🔁 web#1265 accept direct video URLs as input        by ana · 1 ✓
    You commented; author pushed 5 commits since — you haven't looked · 1 unresolved thread of yours
🆕 web#1681 ask the feed again when it ends early    by ana · 0 ✓
    Not looked at yet — your review is requested · blocked by bo, no fixes pushed since

Your PRs (1)
🧑‍💻 web#1688 fix regex differences                   by you · 2 ✓
    Your PR — approved by bo, ana; 1 new comment since your last push

Waiting on others / done (1)
✅ web#1682 fill address from the about source        by ana · 1 ✓
    You approved — nothing for you
```

## Install

Needs Node 18+ and the [GitHub CLI](https://cli.github.com), signed in:

```sh
gh auth login
```

Clone the repository, then add this line to your shell config:

```sh
alias prs='node ~/scripts/pr-review-digest/pr-review-digest.mjs'
```

Authentication is resolved at runtime from `gh auth token`, or from `GITHUB_TOKEN` if you
set it. No token is ever stored by this script or written into the repository.

## Configure

Every variable is optional. Set them in your shell config next to the alias.

| Variable | Meaning |
| --- | --- |
| `DIGEST_REPOS` | `owner/repo` list, comma separated. Every open, non-`blocked` PR in these repos is listed, whoever opened it. Unset means skip this entirely. |
| `DIGEST_GITHUB_ORGS` | Org list, comma separated. Scopes the "requested from you" and "you reviewed" searches. Unset searches all of GitHub, which is usually what you want for a personal account. |
| `DIGEST_MODEL` | Model used by `--ai`. Default `claude-haiku-4-5`. |
| `DIGEST_STATE` | Where `--ack` keeps its watermarks. Default `~/.pr-review-digest.json`. |

For example:

```sh
export DIGEST_GITHUB_ORGS=my-org
export DIGEST_REPOS=my-org/web,my-org/api
```

## Flags

| Flag | Effect |
| --- | --- |
| `--drafts` | Show other people's drafts, in their own section. They are hidden by default and counted on stderr. |
| `--ai` | Replace each PR's description line with a one-sentence summary. Shells out to the local `claude` CLI, so it uses your Claude Code login rather than an API key. Adds roughly 30-60 seconds. |
| `--md [file]` | Also write Markdown. Defaults to `pr-digest-YYYY-MM-DD.md` in the working directory. |
| `--ack PR` | Mark a PR reviewed as of now. Accepts `repo#123`, `owner/repo#123`, or a PR URL. |
| `--unack PR` | Undo an `--ack`. |
| `--acked` | List what is currently marked and when. |

## How PRs are grouped

* **Needs you** — the ball is in your court: never looked at, new commits since you last
  looked, or the author replied to you.
* **Your PRs** — PRs you opened, including your own drafts, which keep a `(draft)` tag.
* **Waiting on others / done** — you approved it, or you requested changes and the author
  has not responded yet.
* **Drafts** — other people's drafts. Hidden unless you pass `--drafts`.

Two notes appear when they apply:

* `· blocked by <names>, no fixes pushed since` — somebody else's "changes requested" is
  still the standing verdict and no commit has landed since. The PR is waiting on its
  author, not on you, so you can skip it. A reviewer who has since approved is not counted.
* `· new activity since you marked it done` — a PR you acked has moved.

## Marking a PR as done

`--ack` records a timestamp, not a permanent mute:

```sh
prs --ack web#41
```

The PR disappears from the digest until somebody **other than you** pushes, comments,
reviews, or re-requests your review. When that happens it returns in its usual place,
carrying the "new activity" note so you can see why. Your own later comments do not
bring it back.

Watermarks live in `~/.pr-review-digest.json`, which is git-ignored.

## Tests

```sh
npm test
```

Covers the classification rules, with no network and no credentials.

## License

MIT
