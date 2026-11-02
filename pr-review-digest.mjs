#!/usr/bin/env node
// pr-review-digest.mjs — "where am I on each PR?"
//
// Sources:  open PRs in the team repos (instagram, facebook, zillow)
//           + open PRs where your review is requested / you already reviewed
// Outputs:  terminal (always), Markdown file (--md [path])
//
// Usage:    node pr-review-digest.mjs [--md [file]] [--ai] [--drafts]
//           [--ack PR]       Mark a PR reviewed as of now: it drops out of the digest until
//                            someone else pushes, comments or reviews. Takes repo#123,
//                            owner/repo#123 or a PR URL.
//           [--unack PR]     Undo that. [--acked] lists what is currently marked.
// Auth:     GitHub only, via `gh auth login` (or GITHUB_TOKEN).
//           --ai one-liners shell out to the local `claude` CLI, which uses your
//           Claude Code login. No ANTHROPIC_API_KEY, no API billing.
// Config:   Optional digest.config.json next to this script; see digest.config.example.json.
//           Every key can also be given as an environment variable, which wins over the file:
//             teamRepos  / DIGEST_REPOS        owner/repo list always shown in full
//             githubOrgs / DIGEST_GITHUB_ORGS  orgs to scope your own PRs to (unset = all
//                                              of GitHub, usually what you want)
//             model      / DIGEST_MODEL        model for --ai (default claude-haiku-4-5)
//             state      / DIGEST_STATE        where --ack keeps its watermarks; a relative
//                                              path resolves against the config file
//                                              (default ~/.pr-review-digest.json)
//           DIGEST_CONFIG points at a different config file.
// Needs Node 18+ (built-in fetch). No npm dependencies.

import { execFileSync, execSync } from 'node:child_process';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Your settings live in digest.config.json next to this script. It is optional and
// git-ignored, so the file can hold private org and repo names. Environment variables
// still win over it, which keeps the script usable from cron or CI with no file at all.
const CONFIG_FILE = process.env.DIGEST_CONFIG || fileURLToPath(new URL('./digest.config.json', import.meta.url));
const fileCfg = (() => {
    try { return JSON.parse(readFileSync(CONFIG_FILE, 'utf8')); } catch { return {}; }
})();

const csv = (v) => (v || '').split(',').map((s) => s.trim()).filter(Boolean);
// Accepts either a real array or a comma-separated string, from either source.
const listOf = (envValue, fileValue) => {
    const fromEnv = csv(envValue);
    if (fromEnv.length) return fromEnv;
    return Array.isArray(fileValue) ? fileValue.map((x) => String(x).trim()).filter(Boolean) : csv(fileValue);
};

const CONFIG = {
    // Scopes the "your review is requested" / "you reviewed" searches. Empty = all of GitHub.
    githubOrgs: listOf(process.env.DIGEST_GITHUB_ORGS, fileCfg.githubOrgs),
    // Open, non-blocked PRs in these repos are listed whoever they belong to. Empty = skip.
    teamRepos: listOf(process.env.DIGEST_REPOS, fileCfg.teamRepos),
    model: process.env.DIGEST_MODEL || fileCfg.model || 'claude-haiku-4-5',
};

// ---------- CLI ----------
const args = process.argv.slice(2);
const has = (name) => args.includes(`--${name}`);
const val = (name) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null;
};
const die = (msg) => { console.error(`✖ ${msg}`); process.exit(1); };
const warn = (msg) => console.error(`⚠ ${msg}`);

// ---------- GitHub ----------
function githubToken() {
    if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
    try {
        return execSync('gh auth token', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    } catch {
        return die('No GitHub token: set GITHUB_TOKEN or run `gh auth login`.');
    }
}
// Resolved on the first API call, so importing this file (e.g. from the tests) needs no gh.
let GH_TOKEN;

async function gql(query) {
    GH_TOKEN ??= githubToken();
    const res = await fetch('https://api.github.com/graphql', {
        method: 'POST',
        headers: { Authorization: `bearer ${GH_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`GitHub API ${res.status}: ${data.message || res.statusText} (check GITHUB_TOKEN / \`gh auth status\`)`);
    if (data.errors) {
        if (!data.data) throw new Error(`GitHub: ${data.errors.map((e) => e.message).join('; ')}`);
        data.errors.forEach((e) => warn(`GitHub: ${e.message}`));
    }
    return data.data;
}

async function prsFromSearch() {
    const orgs = CONFIG.githubOrgs.map((o) => `org:${o}`).join(' ');
    const base = `is:pr is:open archived:false${orgs ? ` ${orgs}` : ''}`;
    const queries = {
        requested: `${base} review-requested:@me`,
        reviewed: `${base} reviewed-by:@me -author:@me`,
    };
    // Without a repo list this query has no bound at all, so only ask for it when configured.
    if (CONFIG.teamRepos.length) {
        queries.team = `is:pr is:open archived:false -label:blocked ${CONFIG.teamRepos.map((r) => `repo:${r}`).join(' ')}`;
    }
    const parts = Object.entries(queries).map(([alias, q]) => `${alias}: search(query: ${JSON.stringify(q)}, type: ISSUE, first: 50) {
        nodes { ... on PullRequest { number repository { name owner { login } } } } }`);
    const data = await gql(`query { ${parts.join('\n')} }`);
    const list = Object.values(data).flatMap((r) => r.nodes);
    const counts = [
        data.team ? `${data.team.nodes.length} open team PRs` : null,
        `${data.requested.nodes.length} requesting you`,
        `${data.reviewed.nodes.length} you've reviewed`,
    ].filter(Boolean);
    console.error(`• GitHub: ${counts.join(', ')}`);
    return list.map((n) => ({ owner: n.repository.owner.login, repo: n.repository.name, number: n.number }));
}

const PR_FIELDS = `
    number title body url state isDraft
    repository { nameWithOwner name }
    author { login }
    reviewRequests(first: 20) { nodes { requestedReviewer { ... on User { login } } } }
    latestOpinionatedReviews(first: 20) { nodes { author { login } state } }
    reviews(last: 100) { nodes { author { login } state submittedAt } }
    timelineItems(last: 100, itemTypes: [PULL_REQUEST_COMMIT, HEAD_REF_FORCE_PUSHED_EVENT, REVIEW_REQUESTED_EVENT]) {
        nodes {
            __typename
            ... on PullRequestCommit { commit { committedDate } }
            ... on HeadRefForcePushedEvent { createdAt }
            ... on ReviewRequestedEvent { createdAt requestedReviewer { ... on User { login } } }
        }
    }
    reviewThreads(last: 50) { nodes { isResolved comments(first: 30) { nodes { author { login } createdAt } } } }
    comments(last: 50) { nodes { author { login } createdAt } }`;

async function fetchPrs(refs) {
    const aliased = refs.map((r, i) => `p${i}: repository(owner: ${JSON.stringify(r.owner)}, name: ${JSON.stringify(r.repo)}) {
        pullRequest(number: ${r.number}) { ${PR_FIELDS} } }`);
    const out = [];
    for (let i = 0; i < aliased.length; i += 10) { // batches keep the query under GitHub's cost limits
        const data = await gql(`query { ${aliased.slice(i, i + 10).join('\n')} }`);
        out.push(...Object.values(data).map((r) => r?.pullRequest).filter(Boolean));
    }
    return out;
}

// ---------- Classification (from your point of view) ----------
const ts = (s) => new Date(s).getTime();
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

export function classify(pr, me) {
    const author = pr.author?.login;
    const latest = pr.latestOpinionatedReviews.nodes;
    const approvals = latest.filter((r) => r.state === 'APPROVED').map((r) => r.author?.login);
    const changesBy = latest.filter((r) => r.state === 'CHANGES_REQUESTED').map((r) => r.author?.login);
    const tl = pr.timelineItems.nodes;
    const pushes = tl.flatMap((n) => (n.__typename === 'PullRequestCommit' ? [ts(n.commit.committedDate)]
        : n.__typename === 'HeadRefForcePushedEvent' ? [ts(n.createdAt)] : []));
    const threadComments = pr.reviewThreads.nodes.flatMap((t) => t.comments.nodes);
    const allComments = [...pr.comments.nodes, ...threadComments];
    const reviews = pr.reviews.nodes.filter((r) => r.state !== 'PENDING');
    // Only your own drafts keep this tag: they stay in "Your PRs" next to your ready PRs,
    // so the tag is the only thing distinguishing them. Everyone else's drafts go to the
    // Drafts section (see main), where the heading already says it. Both rules key off
    // `author === me`, which is exactly when this function returns group 'mine'.
    const draft = pr.isDraft && author === me ? ' (draft)' : '';

    if (author === me) {
        const lastPush = Math.max(0, ...pushes);
        const newFeedback = [...allComments, ...reviews.map((r) => ({ ...r, createdAt: r.submittedAt }))]
            .filter((c) => c.author?.login && c.author.login !== me && ts(c.createdAt) > lastPush).length;
        const parts = [approvals.length ? `approved by ${approvals.join(', ')}` : 'no approvals yet'];
        if (changesBy.length) parts.push(`changes requested by ${changesBy.join(', ')}`);
        if (newFeedback) parts.push(`${plural(newFeedback, 'new comment')} since your last push`);
        return { group: 'mine', icon: '🧑‍💻', state: `Your PR${draft} — ${parts.join('; ')}`, prio: newFeedback || changesBy.length ? 1 : 5 };
    }

    // Someone else's "changes requested" is still the standing verdict and the author has not
    // pushed since: the PR is blocked on the author, not on you. latestOpinionatedReviews holds
    // the current verdict per reviewer, so a reviewer who has since approved is not counted.
    // Falls silent when we cannot date the block or see the commits (truncated API pages),
    // so a missing note never means more than "nothing to report".
    const otherBlockers = changesBy.filter((login) => login && login !== me);
    const lastBlockAt = Math.max(0, ...reviews
        .filter((r) => r.state === 'CHANGES_REQUESTED' && otherBlockers.includes(r.author?.login))
        .map((r) => ts(r.submittedAt)));
    const blockedNote = otherBlockers.length && lastBlockAt && !pushes.some((p) => p > lastBlockAt)
        ? ` · blocked by ${otherBlockers.join(', ')}, no fixes pushed since`
        : '';

    const myTimes = [
        ...reviews.filter((r) => r.author?.login === me).map((r) => ts(r.submittedAt)),
        ...allComments.filter((c) => c.author?.login === me).map((c) => ts(c.createdAt)),
    ];
    const requested = pr.reviewRequests.nodes.some((n) => n.requestedReviewer?.login === me);
    if (!myTimes.length) {
        return { group: 'todo', icon: '🆕', state: `Not looked at yet${requested ? ' — your review is requested' : ''}${blockedNote}${draft}`, prio: 2 };
    }

    const myLast = Math.max(...myTimes);
    const myVerdict = reviews.filter((r) => r.author?.login === me && r.state !== 'COMMENTED').at(-1)?.state;
    const label = { APPROVED: 'You approved', CHANGES_REQUESTED: 'You requested changes', DISMISSED: 'Your review was dismissed' }[myVerdict] || 'You commented';
    const pushedSince = pushes.filter((p) => p > myLast).length;
    const authorReplied = allComments.some((c) => c.author?.login === author && ts(c.createdAt) > myLast);
    const reRequested = tl.some((n) => n.__typename === 'ReviewRequestedEvent' && n.requestedReviewer?.login === me && ts(n.createdAt) > myLast);
    const myOpenThreads = pr.reviewThreads.nodes.filter((t) => !t.isResolved && t.comments.nodes[0]?.author?.login === me).length;

    let r;
    if (myVerdict === 'APPROVED' && !pushedSince) r = { icon: '✅', state: `${label} — nothing for you`, prio: 9, group: 'waiting' };
    else if (myVerdict === 'APPROVED') r = { icon: '🔄', state: `${label}, but ${plural(pushedSince, 'new commit')} since`, prio: 4, group: 'todo' };
    else if (pushedSince) r = { icon: '🔁', state: `${label}; author pushed ${plural(pushedSince, 'commit')}${authorReplied ? ' and replied' : ''} since — you haven't looked`, prio: 1, group: 'todo' };
    else if (authorReplied) r = { icon: '💬', state: `${label}; author replied, no new code`, prio: 3, group: 'todo' };
    else r = { icon: '⏳', state: `${label}; waiting on the author`, prio: 7, group: 'waiting' };

    if (reRequested) { r.state += ' · re-requested your review'; r.prio = Math.min(r.prio, 1); r.group = 'todo'; }
    if (myOpenThreads && myVerdict !== 'APPROVED') r.state += ` · ${plural(myOpenThreads, 'unresolved thread')} of yours`;
    r.state += blockedNote;
    r.state += draft;
    return r;
}

// ---------- "I reviewed this; ask me again when it changes" ----------
// A JSON file of `repo#number` -> ISO timestamp. An acked PR is hidden until somebody
// other than you pushes, comments, or reviews after that moment.
// A relative `state` in the config file resolves against that file, so you can keep the
// watermarks beside the script without writing an absolute path.
const STATE_FILE = process.env.DIGEST_STATE
    || (fileCfg.state ? resolve(dirname(CONFIG_FILE), fileCfg.state) : `${homedir()}/.pr-review-digest.json`);

const loadAcks = () => { try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return {}; } };
const saveAcks = (acks) => writeFileSync(STATE_FILE, `${JSON.stringify(acks, null, 2)}\n`);

// Accepts `repo#123`, `owner/repo#123` or a PR URL; stores the `repo#123` form the digest prints.
function ackKey(input) {
    const url = (input || '').match(/github\.com\/[\w.-]+\/([\w.-]+)\/pull\/(\d+)/);
    if (url) return `${url[1]}#${url[2]}`;
    const short = (input || '').match(/([\w.-]+)#(\d+)$/);
    return short ? `${short[1]}#${short[2]}` : null;
}

// Newest thing anyone but you did: a commit, a comment, a review, or a request for your review.
// Pushes carry no author in this query, so a push of your own would also count; that is rare
// on someone else's PR and only ever errs toward showing you the PR again.
function lastActivityByOthers(pr, me) {
    const mine = (login) => !login || login === me;
    return Math.max(0,
        ...pr.timelineItems.nodes.flatMap((n) => (n.__typename === 'PullRequestCommit' ? [ts(n.commit.committedDate)]
            : n.__typename === 'HeadRefForcePushedEvent' ? [ts(n.createdAt)]
            : n.__typename === 'ReviewRequestedEvent' && n.requestedReviewer?.login === me ? [ts(n.createdAt)] : [])),
        ...[...pr.comments.nodes, ...pr.reviewThreads.nodes.flatMap((t) => t.comments.nodes)]
            .filter((c) => !mine(c.author?.login)).map((c) => ts(c.createdAt)),
        ...pr.reviews.nodes.filter((r) => r.state !== 'PENDING' && !mine(r.author?.login)).map((r) => ts(r.submittedAt)),
    );
}

// ---------- One-liner about the PR ----------
function firstLine(body) {
    const line = (body || '').replace(/<!--[\s\S]*?-->/g, '').split('\n').map((l) => l.trim())
        .find((l) => l && !/^(#|>|- \[|\* \[|\|)/.test(l) && !/^(closes|fixes|resolves|related)\b/i.test(l));
    if (!line) return null;
    const clean = line.replace(/[*_`]/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/^[-*]\s+/, '');
    return clean.length > 140 ? `${clean.slice(0, 137)}…` : clean;
}

async function aiSummaries(prs) {
    const input = prs.map((p) => ({ id: p.url, title: p.title, body: (p.body || '').slice(0, 2000) }));
    const prompt = `For each pull request, write ONE plain sentence (max 20 words) saying what it changes and why, for a reviewer. Reply with only a JSON object mapping id to sentence.\n\n${JSON.stringify(input)}`;
    try {
        // The CLI uses the Claude Code login on this machine, so there is no API key to manage.
        // It answers slower than a direct API call, hence the long timeout.
        const text = execFileSync('claude', ['-p', '--model', CONFIG.model, '--allowed-tools', ''], {
            input: prompt,
            encoding: 'utf8',
            timeout: 180_000,
            maxBuffer: 10 * 1024 * 1024,
        });
        return JSON.parse(text.replace(/```json|```/g, '').trim());
    } catch (e) {
        const reason = e.code === 'ENOENT' ? 'the `claude` CLI is not installed' : e.message;
        warn(`AI summaries failed (${reason}); using PR descriptions instead.`);
        return {};
    }
}

// ---------- Rendering ----------
const SECTIONS = [['todo', 'Needs you'], ['mine', 'Your PRs'], ['waiting', 'Waiting on others / done'], ['drafts', 'Drafts']];

function render(items, style) {
    const lines = [];
    const link = (it) => (style === 'md' ? `[${it.repo}#${it.number}](${it.url})` : `${it.repo}#${it.number}`);
    const bold = (s) => (style === 'md' ? `**${s}**` : `\x1b[1m${s}\x1b[0m`);
    const dim = (s) => (style === 'md' ? `*${s}*` : `\x1b[2m${s}\x1b[0m`);
    for (const [group, title] of SECTIONS) {
        const its = items.filter((i) => i.group === group).sort((a, b) => a.prio - b.prio);
        if (!its.length) continue;
        lines.push('', style === 'md' ? `## ${title}` : bold(`${title} (${its.length})`));
        for (const it of its) {
            const head = `${it.icon} ${link(it)} ${it.title} ${dim(`by ${it.author} · ${it.approvals} ✓`)}`;
            lines.push(style === 'md' ? `- ${head}` : head);
            lines.push(`${style === 'md' ? '  - ' : '    '}${it.state}`);
            lines.push(`${style === 'md' ? '  - ' : '    ↳ '}${it.about}`);
            if (style === 'term') lines.push(dim(`    ${it.url}`));
        }
    }
    return lines.join('\n');
}

// ---------- Main ----------
async function main() {
    if (has('acked')) {
        const acks = loadAcks();
        const keys = Object.keys(acks).sort();
        console.log(keys.length
            ? keys.map((k) => `${k}  (marked ${new Date(acks[k]).toLocaleString()})`).join('\n')
            : 'Nothing is marked as done.');
        return;
    }
    if (has('ack') || has('unack')) {
        const key = ackKey(val('ack') || val('unack'));
        if (!key) return die('Name a PR as repo#123, owner/repo#123, or its URL.');
        const acks = loadAcks();
        if (has('unack')) {
            delete acks[key];
            saveAcks(acks);
            console.log(`${key}: back in the digest.`);
        } else {
            acks[key] = new Date().toISOString();
            saveAcks(acks);
            console.log(`${key}: marked done. It returns when someone else pushes, comments, or reviews.`);
        }
        return;
    }

    const refs = [];
    refs.push(...await prsFromSearch());
    const unique = [...new Map(refs.map((r) => [`${r.owner}/${r.repo}#${r.number}`, r])).values()];
    if (!unique.length) die('No PRs found.');

    const { viewer } = await gql('query { viewer { login } }');
    const prs = (await fetchPrs(unique)).filter((p) => p.state === 'OPEN');
    const summaries = has('ai') ? await aiSummaries(prs) : {};

    const acks = loadAcks();
    const all = prs.map((pr) => {
        const item = {
            ...classify(pr, viewer.login),
            url: pr.url, number: pr.number, repo: pr.repository.name, title: pr.title,
            author: pr.author?.login ?? 'ghost',
            approvals: pr.latestOpinionatedReviews.nodes.filter((r) => r.state === 'APPROVED').length,
            about: summaries[pr.url] || firstLine(pr.body) || '(no description)',
        };
        // Other people's drafts move to their own section so they never crowd the PRs you
        // can act on. Your own drafts stay under "Your PRs", tagged by classify().
        if (pr.isDraft && item.group !== 'mine') item.group = 'drafts';
        // A PR you marked done stays out of the way until it actually moves.
        const ackedAt = acks[`${item.repo}#${item.number}`] ? ts(acks[`${item.repo}#${item.number}`]) : 0;
        if (!ackedAt) return item;
        if (lastActivityByOthers(pr, viewer.login) > ackedAt) item.state += ' · new activity since you marked it done';
        else item.group = 'acked';
        return item;
    });
    const draftCount = all.filter((i) => i.group === 'drafts').length;
    const ackedCount = all.filter((i) => i.group === 'acked').length;
    const items = (has('drafts') ? all : all.filter((i) => i.group !== 'drafts')).filter((i) => i.group !== 'acked');
    if (draftCount && !has('drafts')) console.error(`• ${plural(draftCount, 'draft')} from others hidden; pass --drafts to list them.`);
    if (ackedCount) console.error(`• ${ackedCount} marked done and unchanged; pass --acked to list.`);

    const header = `PR review digest — ${new Date().toLocaleString()} (${items.length} open PRs, as ${viewer.login})`;
    console.log(`\n${header}${render(items, 'term')}\n`);

    if (has('md')) {
        const file = val('md') || `pr-digest-${new Date().toISOString().slice(0, 10)}.md`;
        writeFileSync(file, `# ${header}\n${render(items, 'md')}\n`);
        console.error(`• Wrote ${file}`);
    }
}

// Run main() when executed directly (not when imported). Compare real paths so spaces,
// symlinks and relative paths don't make this silently skip.
const isDirectRun = (() => {
    try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
    catch { return false; }
})();
if (isDirectRun) main().catch((e) => die(e.message));
