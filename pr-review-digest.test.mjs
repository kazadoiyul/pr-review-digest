// Unit tests for the classification rules. No network, no credentials: `node --test` style
// assertions kept deliberately dependency-free so this runs anywhere Node 18+ does.
import { classify } from './pr-review-digest.mjs';

const ME = 'me';
const T = (day) => `2026-01-${String(day).padStart(2, '0')}T12:00:00Z`;

const pr = ({ opinionated = [], reviews = [], commits = [], isDraft = false, author = 'other' }) => ({
    number: 1, title: 't', body: '', url: 'u', state: 'OPEN', isDraft,
    repository: { name: 'r', nameWithOwner: 'o/r' }, author: { login: author },
    reviewRequests: { nodes: [] },
    latestOpinionatedReviews: { nodes: opinionated },
    reviews: { nodes: reviews },
    timelineItems: { nodes: commits.map((d) => ({ __typename: 'PullRequestCommit', commit: { committedDate: T(d) } })) },
    reviewThreads: { nodes: [] },
    comments: { nodes: [] },
});
const standing = (who, state) => ({ author: { login: who }, state });
const review = (who, state, day) => ({ author: { login: who }, state, submittedAt: T(day) });

const cases = [
    ['blocked by someone else, no push since', 'blocked by', true,
        pr({ opinionated: [standing('amy', 'CHANGES_REQUESTED')], reviews: [review('amy', 'CHANGES_REQUESTED', 5)], commits: [1, 4] })],
    ['blocked, but the author pushed after', 'blocked by', false,
        pr({ opinionated: [standing('amy', 'CHANGES_REQUESTED')], reviews: [review('amy', 'CHANGES_REQUESTED', 5)], commits: [1, 9] })],
    ['blocker has since approved', 'blocked by', false,
        pr({ opinionated: [standing('amy', 'APPROVED')], reviews: [review('amy', 'CHANGES_REQUESTED', 5), review('amy', 'APPROVED', 6)], commits: [1] })],
    ['only I requested changes', 'blocked by', false,
        pr({ opinionated: [standing(ME, 'CHANGES_REQUESTED')], reviews: [review(ME, 'CHANGES_REQUESTED', 5)], commits: [1] })],
    ['two standing blockers are both named', 'blocked by amy, bo', true,
        pr({ opinionated: [standing('amy', 'CHANGES_REQUESTED'), standing('bo', 'CHANGES_REQUESTED')], reviews: [review('amy', 'CHANGES_REQUESTED', 5), review('bo', 'CHANGES_REQUESTED', 6)], commits: [1] })],
    ['my own draft keeps its tag', '(draft)', true, pr({ isDraft: true, author: ME, commits: [1] })],
    ["someone else's draft drops the tag", '(draft)', false, pr({ isDraft: true, commits: [1] })],
    ['my own PR is grouped as mine', 'Your PR', true, pr({ author: ME, commits: [1] })],
];

let failed = 0;
for (const [name, needle, want, fixture] of cases) {
    const { state } = classify(fixture, ME);
    const ok = state.includes(needle) === want;
    if (!ok) failed++;
    console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}`);
    if (!ok) console.log(`      wanted ${want ? '' : 'no '}"${needle}" in: ${state}`);
}
console.log(failed ? `\n${failed} of ${cases.length} failed` : `\n${cases.length} passed`);
process.exit(failed ? 1 : 0);
