// Everything that talks to git and GitHub. GitHub goes through gh (its login, its hosts):
// `gh api graphql` for reading and for review actions, `gh api` (REST) for Actions, files,
// comments and state. Pull requests come back in the shape the GitLab panel used for merge
// requests (iid, sourceBranch, headPipeline…), so the drawing code stays the same.
// `ctx` is plain data, so popups and dialogs get it in their props:
// { host, path, root, on, remote, web, origin, me, main }.

import { exec, setShared, spaces } from "herdr";
import { firstLine, nodes, parseRemote, checkStatus, contextStatus, rollup, seconds, ACTIVE } from "./util.js";

const CHECKS = `fragment checks on Commit {
  oid abbreviatedOid messageHeadline committedDate
  statusCheckRollup { state contexts(first: 100) { nodes { __typename
    ... on CheckRun { databaseId name status conclusion detailsUrl startedAt completedAt
      checkSuite { app { name } workflowRun { databaseId workflow { name } } } }
    ... on StatusContext { context state targetUrl createdAt }
  } } }
}`;

const PR = `fragment pr on PullRequest {
  id number title state isDraft url createdAt updatedAt headRefName baseRefName headRefOid isCrossRepository
  mergeable mergeStateStatus reviewDecision viewerCanUpdate additions deletions changedFiles
  author { login }
  reviewRequests(first: 10) { nodes { requestedReviewer { ... on User { login } } } }
  latestOpinionatedReviews(first: 20) { nodes { databaseId state author { login } } }
  reviewThreads(first: 100) { totalCount nodes { isResolved } }
  rollup: commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
}`;

// The panel's top: this branch, the counts; the recent runs come over REST beside it.
const SUMMARY_QUERY = `query($owner: String!, $name: String!, $branch: String!, $ref: String!) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    url viewerPermission defaultBranchRef { name }
    openPrs: pullRequests(states: OPEN) { totalCount }
    openIssues: issues(states: OPEN) { totalCount }
    branchPr: pullRequests(headRefName: $branch, first: 10, orderBy: { field: CREATED_AT, direction: DESC }) {
      nodes { ...pr head: commits(last: 1) { nodes { commit { ...checks } } } } }
    ref(qualifiedName: $ref) { target { ... on Commit { ...checks } } }
  }
}
${PR}
${CHECKS}`;

// One page of a sub-tab's list; `states` goes in as enum literals from a fixed set.
const PR_STATES = { open: "OPEN", merged: "MERGED", closed: "CLOSED", all: null };
const ISSUE_STATES = { open: "OPEN", closed: "CLOSED", all: null };
const statesArg = (s) => (s ? `states: [${s}], ` : "");
const prPage = (states) => `query($owner: String!, $name: String!, $first: Int!, $after: String) {
  viewer { login }
  repository(owner: $owner, name: $name) { viewerPermission
    list: pullRequests(${statesArg(states)}first: $first, after: $after, orderBy: { field: UPDATED_AT, direction: DESC }) {
      totalCount pageInfo { endCursor hasNextPage } nodes { ...pr } } }
}
${PR}`;
const issuePage = (states) => `query($owner: String!, $name: String!, $first: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    list: issues(${statesArg(states)}first: $first, after: $after, orderBy: { field: UPDATED_AT, direction: DESC }) {
      totalCount pageInfo { endCursor hasNextPage } nodes {
        id number state title body url updatedAt author { login } assignees(first: 3) { nodes { login } } labels(first: 5) { nodes { name color } } } } }
}`;

const PR_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    viewerPermission
    pullRequest(number: $number) {
      ...pr body
      head: commits(last: 1) { nodes { commit { ...checks } } }
      comments(first: 100) { nodes { id body createdAt url author { login } } }
      reviews(first: 50) { nodes { id body state createdAt url author { login } } }
      reviewThreads(first: 100) { nodes { id isResolved path line originalLine viewerCanResolve viewerCanUnresolve viewerCanReply
        comments(first: 50) { nodes { id body createdAt url author { login } } } } }
    }
  }
}
${PR}
${CHECKS}`;

const repo = (ctx) => `repos/${ctx.path}`;
const ownerName = (ctx) => { const [owner, name] = ctx.path.split("/"); return { owner, name }; };

async function gh(ctx, args) {
  const r = await exec("gh", args, { cwd: ctx.root, on: ctx.on }).catch(() => null);
  if (!r) throw new Error("gh isn't installed: https://cli.github.com");
  return r;
}

// GitHub's message: a GraphQL error, a REST { message, errors }, or gh's own line.
function problem(r, body) {
  const m = body?.errors?.[0]?.message ?? body?.message;
  if (typeof m === "string") return new Error(m);
  return new Error(firstLine(r.stderr || r.stdout) || `gh exited with ${r.code}`);
}

// Strings go as -f (raw), the rest as -F (typed: booleans, numbers).
const fieldArgs = (fields) => Object.entries(fields).filter(([, v]) => v !== undefined && v !== null)
  .flatMap(([k, v]) => [typeof v === "string" ? "-f" : "-F", `${k}=${v}`]);

export async function graphql(ctx, query, vars = {}) {
  const r = await gh(ctx, ["api", "graphql", "--hostname", ctx.host, "-f", `query=${query}`, ...fieldArgs(vars)]);
  let body = null;
  try { body = JSON.parse(r.stdout); } catch { body = null; }
  if (r.code !== 0 || !body?.data || body.errors?.length) throw problem(r, body);
  return body.data;
}

export async function rest(ctx, method, endpoint, fields = {}) {
  const r = await gh(ctx, ["api", "--hostname", ctx.host, "-X", method, endpoint, ...fieldArgs(fields)]);
  let body = null;
  try { body = r.stdout.trim() ? JSON.parse(r.stdout) : null; } catch { body = null; }
  if (r.code !== 0) throw problem(r, body);
  return body;
}

// After an action anywhere (a popup, a dialog), every copy of the panel reloads.
export const bump = () => setShared("github.bump", Date.now());

// Hosts gh is signed in to, checked once per host.
const signedIn = new Map();
async function ghKnows(host, cwd, on) {
  if (!signedIn.has(host)) {
    const r = await exec("gh", ["auth", "status", "--hostname", host], { cwd, on }).catch(() => null);
    signedIn.set(host, r?.code === 0);
  }
  return signedIn.get(host);
}

// The repo a folder belongs to and its GitHub repository, from the git remote.
export async function locate({ cwd, on }) {
  const git = async (args, dir) => {
    const r = await exec("git", ["--no-optional-locks", ...args], { cwd: dir, on });
    return { ok: r.code === 0, out: (r.stdout ?? "").trim() };
  };
  const top = await git(["rev-parse", "--show-toplevel"], cwd);
  if (!top.ok) return { error: "Not a git repository" };
  const root = top.out;
  let remote = "origin", url = await git(["remote", "get-url", "origin"], root);
  if (!url.ok) {
    remote = (await git(["remote"], root)).out.split("\n").filter(Boolean)[0];
    if (!remote) return { root, error: "This repository has no remote" };
    url = await git(["remote", "get-url", remote], root);
  }
  const parsed = parseRemote(url.out);
  if (!parsed) return { root, error: `Unrecognized remote: ${url.out}` };
  let host = parsed.host;
  // github.com, a GitHub Enterprise host gh is signed in to, or an ssh alias such as
  // github-work (Host in ~/.ssh/config), which is github.com under another name.
  if (host !== "github.com" && !(await ghKnows(host, root, on))) {
    if (!/github/i.test(host)) return { root, error: "Not a GitHub remote: this panel shows GitHub repositories", other: "gitlab" };
    host = "github.com";
  }
  if (parsed.path.split("/").length !== 2) return { root, error: `Not a GitHub repository path: ${parsed.path}` };
  const branch = (await git(["branch", "--show-current"], root)).out;
  return { root, on, remote, host, path: parsed.path, branch };
}

// ── shapes ───────────────────────────────────────────────────────────────────

const WRITE = new Set(["WRITE", "MAINTAIN", "ADMIN"]);
const STATE = { OPEN: "opened", MERGED: "merged", CLOSED: "closed" };

// Why a pull request can or can't merge, as one key of ui.js's table.
export function mergeKey(pr) {
  if (pr.isDraft) return "DRAFT_STATUS";
  if (pr.mergeable === "CONFLICTING" || pr.mergeStateStatus === "DIRTY") return "CONFLICT";
  const checks = contextStatus(nodes(pr.rollup)[0]?.commit?.statusCheckRollup?.state);
  switch (pr.mergeStateStatus) {
    case "CLEAN": case "HAS_HOOKS": return "MERGEABLE";
    case "UNSTABLE": return "UNSTABLE";
    case "BEHIND": return "BEHIND";
    case "BLOCKED":
      if (pr.reviewDecision === "CHANGES_REQUESTED") return "REQUESTED_CHANGES";
      if (ACTIVE.has(checks)) return "CI_STILL_RUNNING";
      if (checks === "FAILED") return "CI_FAILED";
      if (pr.reviewDecision === "REVIEW_REQUIRED") return "NOT_APPROVED";
      return "BLOCKED_STATUS";
    default: return "CHECKING";
  }
}

// A commit's checks as one "pipeline": a stage per workflow (or app), a job per check run.
function fromCommit(c, url, ref) {
  const roll = c?.statusCheckRollup;
  if (!roll) return null;
  const groups = new Map(), runs = new Map();
  for (const x of nodes(roll.contexts)) {
    let group, job;
    if (x.__typename === "CheckRun") {
      const run = x.checkSuite?.workflowRun, status = checkStatus(x.status, x.conclusion);
      group = run?.workflow?.name ?? x.checkSuite?.app?.name ?? "Checks";
      job = { id: String(x.databaseId), name: x.name, status, url: x.detailsUrl, startedAt: x.startedAt, endedAt: x.completedAt,
        duration: x.completedAt ? seconds(x.startedAt, x.completedAt) : null, log: Boolean(run), runId: run?.databaseId ?? null,
        retryable: Boolean(run) && (status === "FAILED" || status === "CANCELED") };
      if (run) runs.set(run.databaseId, [...(runs.get(run.databaseId) ?? []), status]);
    } else {
      group = "Statuses";
      job = { id: x.context, name: x.context, status: contextStatus(x.state), url: x.targetUrl, startedAt: x.createdAt, endedAt: null,
        duration: null, log: false, runId: null, retryable: false };
    }
    groups.set(group, [...(groups.get(group) ?? []), job]);
  }
  const jobs = [...groups.values()].flat(), status = rollup(jobs.map((j) => j.status));
  const starts = jobs.map((j) => j.startedAt).filter(Boolean).sort(), ends = jobs.map((j) => j.endedAt).filter(Boolean).sort();
  return {
    id: `checks-${c.oid}`, label: "Checks", status, ref, url, createdAt: c.committedDate, startedAt: starts[0] ?? null,
    duration: ACTIVE.has(status) ? null : seconds(starts[0], ends.at(-1)),
    user: null, commit: { shortId: c.abbreviatedOid, title: c.messageHeadline },
    stages: [...groups].map(([name, list]) => ({ name, jobs: list })),
    runs: [...runs].map(([id, list]) => ({ id, status: rollup(list) })),
  };
}

// A workflow run from REST: its jobs load when the row opens (jobsOf).
function fromRun(r) {
  const status = checkStatus(r.status, r.conclusion), start = r.run_started_at ?? r.created_at;
  return {
    id: `run-${r.id}`, runId: r.id, label: `${r.name} #${r.run_number}`, status, ref: r.head_branch ?? "", url: r.html_url,
    createdAt: r.created_at, startedAt: start, duration: ACTIVE.has(status) ? null : seconds(start, r.updated_at),
    user: { username: r.triggering_actor?.login ?? r.actor?.login ?? null }, commit: { shortId: r.head_sha?.slice(0, 7), title: r.display_title },
    stages: null, runs: [{ id: r.id, status }],
  };
}

function toMr(pr, me, permission, headPipeline) {
  const approvals = nodes(pr.latestOpinionatedReviews).filter((r) => r.state === "APPROVED");
  const threads = nodes(pr.reviewThreads), author = pr.author?.login ?? null;
  return {
    id: pr.id, iid: String(pr.number), title: pr.title, state: STATE[pr.state] ?? String(pr.state).toLowerCase(), draft: pr.isDraft,
    webUrl: pr.url, createdAt: pr.createdAt, updatedAt: pr.updatedAt, sourceBranch: pr.headRefName, targetBranch: pr.baseRefName,
    headSha: pr.headRefOid, crossRepo: pr.isCrossRepository, detailedMergeStatus: mergeKey(pr),
    author: { username: author },
    reviewers: { nodes: nodes(pr.reviewRequests).map((r) => ({ username: r.requestedReviewer?.login })).filter((r) => r.username) },
    approvedBy: { nodes: approvals.map((r) => ({ username: r.author?.login })) },
    myApproval: approvals.find((r) => r.author?.login === me)?.databaseId ?? null,
    userPermissions: {
      canMerge: WRITE.has(permission), canApprove: Boolean(me) && author !== me, canDismiss: WRITE.has(permission),
      updateMergeRequest: Boolean(pr.viewerCanUpdate), createNote: true,
    },
    diffStatsSummary: { additions: pr.additions, deletions: pr.deletions, fileCount: pr.changedFiles },
    resolvableDiscussionsCount: pr.reviewThreads?.totalCount ?? threads.length,
    resolvedDiscussionsCount: threads.filter((t) => t.isResolved).length,
    // A list row needs only the state; a card gets the full checks (null: none).
    headPipeline: headPipeline !== undefined ? headPipeline : rollupOnly(pr),
  };
}

function rollupOnly(pr) {
  const state = nodes(pr.rollup)[0]?.commit?.statusCheckRollup?.state;
  return state ? { status: contextStatus(state) } : null;
}

const toIssue = (i) => ({
  id: i.id, iid: String(i.number), state: i.state, title: i.title, description: i.body ?? "", webUrl: i.url, updatedAt: i.updatedAt,
  author: { username: i.author?.login ?? null }, assignees: { nodes: nodes(i.assignees).map((a) => ({ username: a.login })) },
  labels: { nodes: nodes(i.labels).map((l) => ({ title: l.name, color: l.color ? `#${l.color}` : null })) },
});

// Review threads (resolvable, on a line), plain comments and review summaries, oldest first.
function discussions(pr) {
  const note = (c, position) => ({ id: c.id, body: c.body ?? "", system: false, createdAt: c.createdAt, url: c.url, author: { username: c.author?.login ?? "ghost" }, position });
  const threads = nodes(pr.reviewThreads).map((th) => ({
    id: th.id, resolvable: true, resolved: th.isResolved, canResolve: th.isResolved ? th.viewerCanUnresolve : th.viewerCanResolve, canReply: th.viewerCanReply,
    notes: { nodes: nodes(th.comments).map((c) => note(c, { filePath: th.path, newLine: th.line, oldLine: th.originalLine })) },
  }));
  const single = (c) => ({ id: c.id, resolvable: false, resolved: false, canResolve: false, canReply: false, notes: { nodes: [note(c, null)] } });
  const reviews = nodes(pr.reviews).filter((r) => r.body?.trim()).map(single);
  const first = (d) => Date.parse(d.notes.nodes[0]?.createdAt ?? 0) || 0;
  return [...threads, ...nodes(pr.comments).map(single), ...reviews].sort((a, b) => first(a) - first(b));
}

const toDiff = (f) => ({
  new_path: f.filename, old_path: f.previous_filename ?? f.filename,
  new_file: f.status === "added", deleted_file: f.status === "removed", renamed_file: f.status === "renamed",
  diff: f.patch ?? "", too_large: !f.patch && f.changes > 0, _c: { add: f.additions ?? 0, del: f.deletions ?? 0 },
});

// ── reading ──────────────────────────────────────────────────────────────────

// Of a branch's pull requests (newest first), the one to show: not a fork's (headRefName
// matches forks' branches too, a fork's "main" is not this branch), open first.
export function pickBranchPr(list) {
  const own = list.filter((pr) => !pr.isCrossRepository);
  return own.find((pr) => pr.state === "OPEN") ?? own[0] ?? null;
}

export async function loadSummary(ctx, branch) {
  const { owner, name } = ownerName(ctx);
  const [data, runs] = await Promise.all([
    graphql(ctx, SUMMARY_QUERY, { owner, name, branch: branch ?? "", ref: `refs/heads/${branch ?? ""}` }),
    rest(ctx, "GET", `${repo(ctx)}/actions/runs?per_page=12`).catch(() => null),
  ]);
  const r = data.repository;
  if (!r) return null;
  const me = data.viewer?.login ?? null, perm = r.viewerPermission;
  const bp = pickBranchPr(nodes(r.branchPr));
  const branchMr = bp ? toMr(bp, me, perm, fromCommit(nodes(bp.head)[0]?.commit, `${bp.url}/checks`, bp.headRefName)) : null;
  const tip = r.ref?.target;
  return {
    web: r.url,
    origin: /^(https?:\/\/[^/]+)/.exec(r.url)?.[1] ?? `https://${ctx.host}`,
    main: r.defaultBranchRef?.name ?? null,
    me,
    branchMr,
    branchPipeline: branchMr ? branchMr.headPipeline : tip?.oid ? fromCommit(tip, `${r.url}/commit/${tip.oid}`, branch) : null,
    mrCount: r.openPrs?.totalCount ?? 0, issueCount: r.openIssues?.totalCount ?? 0,
    // Not the Runs tab: what notifications and the polling pace look at. A skipped run is all noise.
    pipelines: (runs?.workflow_runs ?? []).map(fromRun).filter((p) => p.status !== "SKIPPED"),
  };
}

// One page of a sub-tab: { items, next, count }. `filter`: open, merged, closed or all.
// Runs page by number over REST, so their cursor is the next page's number.
export async function loadPage(ctx, kind, { filter = "open", after = null, first = 20 } = {}) {
  if (kind === "pipelines") {
    const page = Number(after ?? 1);
    const body = await rest(ctx, "GET", `${repo(ctx)}/actions/runs?per_page=${first}&page=${page}`);
    const runs = body?.workflow_runs ?? [], total = body?.total_count ?? 0;
    return {
      items: runs.map(fromRun).filter((p) => p.status !== "SKIPPED"),
      next: runs.length === first && page * first < total ? String(page + 1) : null,
      count: body?.total_count ?? null,
    };
  }
  const { owner, name } = ownerName(ctx);
  const states = kind === "mrs" ? PR_STATES : ISSUE_STATES;
  const query = (kind === "mrs" ? prPage : issuePage)(states[filter] === undefined ? states.open : states[filter]);
  const data = await graphql(ctx, query, { owner, name, first, after });
  const list = data.repository?.list;
  if (!list) throw new Error(`No repository ${ctx.path} on ${ctx.host} (or no access)`);
  const me = data.viewer?.login ?? null, perm = data.repository.viewerPermission;
  return {
    items: kind === "mrs" ? nodes(list).map((pr) => toMr(pr, me, perm)) : nodes(list).map(toIssue),
    next: list.pageInfo?.hasNextPage ? list.pageInfo.endCursor : null,
    count: list.totalCount ?? null,
  };
}

// A workflow run's jobs, as one stage.
export async function jobsOf(ctx, runId) {
  const body = await rest(ctx, "GET", `${repo(ctx)}/actions/runs/${runId}/jobs?per_page=100&filter=latest`);
  const jobs = (body?.jobs ?? []).map((j) => {
    const status = checkStatus(j.status, j.conclusion);
    return { id: String(j.id), name: j.name, status, url: j.html_url, startedAt: j.started_at, endedAt: j.completed_at,
      duration: j.completed_at ? seconds(j.started_at, j.completed_at) : null, log: true, runId,
      retryable: status === "FAILED" || status === "CANCELED" };
  });
  return [{ name: "", jobs }];
}

// One pull request with its threads, plus its files (REST: the first 100).
export async function loadMr(ctx, iid) {
  const { owner, name } = ownerName(ctx);
  const [data, files] = await Promise.all([
    graphql(ctx, PR_QUERY, { owner, name, number: Number(iid) }),
    rest(ctx, "GET", `${repo(ctx)}/pulls/${iid}/files?per_page=100`).catch((e) => ({ error: e.message })),
  ]);
  const pr = data.repository?.pullRequest;
  if (!pr) throw new Error(`No pull request #${iid}`);
  const mr = toMr(pr, data.viewer?.login ?? null, data.repository.viewerPermission, fromCommit(nodes(pr.head)[0]?.commit, `${pr.url}/checks`, pr.headRefName));
  mr.description = pr.body ?? "";
  mr.discussions = { nodes: discussions(pr) };
  return { mr, diffs: Array.isArray(files) ? files.map(toDiff) : [], diffError: files?.error ?? null };
}

// What the merge dialog needs: the pull request as it is now and the repository's merge settings.
export async function mergeInfo(ctx, iid) {
  const { owner, name } = ownerName(ctx);
  const data = await graphql(ctx, `query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) {
    mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed deleteBranchOnMerge autoMergeAllowed viewerDefaultMergeMethod
    pullRequest(number: $number) { id number title state isDraft headRefName baseRefName headRefOid isCrossRepository
      mergeable mergeStateStatus reviewDecision autoMergeRequest { enabledAt } commits { totalCount }
      rollup: commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } } } }`, { owner, name, number: Number(iid) });
  const r = data.repository, pr = r?.pullRequest;
  if (!pr) throw new Error(`No pull request #${iid}`);
  const methods = [r.mergeCommitAllowed && "MERGE", r.squashMergeAllowed && "SQUASH", r.rebaseMergeAllowed && "REBASE"].filter(Boolean);
  return {
    mr: {
      id: pr.id, iid: String(pr.number), title: pr.title, state: STATE[pr.state] ?? "", sourceBranch: pr.headRefName, targetBranch: pr.baseRefName,
      headSha: pr.headRefOid, crossRepo: pr.isCrossRepository, detailedMergeStatus: mergeKey(pr), commitCount: pr.commits?.totalCount ?? 0,
      autoMerge: Boolean(pr.autoMergeRequest), checks: contextStatus(nodes(pr.rollup)[0]?.commit?.statusCheckRollup?.state),
    },
    settings: { methods, preferred: r.viewerDefaultMergeMethod, deleteBranchOnMerge: r.deleteBranchOnMerge, autoMergeAllowed: r.autoMergeAllowed },
  };
}

// ── actions ──────────────────────────────────────────────────────────────────

export const approve = (ctx, iid) => rest(ctx, "POST", `${repo(ctx)}/pulls/${iid}/reviews`, { event: "APPROVE" });
// GitHub has no "unapprove": the approval is dismissed, which takes write access.
export const unapprove = (ctx, iid, review) => rest(ctx, "PUT", `${repo(ctx)}/pulls/${iid}/reviews/${review}/dismissals`, { message: "Approval withdrawn", event: "DISMISS" });
export const setState = (ctx, iid, event) => rest(ctx, "PATCH", `${repo(ctx)}/pulls/${iid}`, { state: event === "close" ? "closed" : "open" });

const refPath = (branch) => branch.split("/").map(encodeURIComponent).join("/");

// `sha`: merges only what was reviewed. `auto`: when the requirements are met (GitHub's
// auto-merge; the repository's own setting decides about the branch then).
export async function merge(ctx, mr, { method, removeSource, auto }) {
  const vars = { id: mr.id, method, sha: mr.headSha };
  if (auto) {
    await graphql(ctx, `mutation($id: ID!, $method: PullRequestMergeMethod!, $sha: GitObjectID) {
      enablePullRequestAutoMerge(input: { pullRequestId: $id, mergeMethod: $method, expectedHeadOid: $sha }) { clientMutationId } }`, vars);
    return { state: "auto" };
  }
  const data = await graphql(ctx, `mutation($id: ID!, $method: PullRequestMergeMethod!, $sha: GitObjectID) {
    mergePullRequest(input: { pullRequestId: $id, mergeMethod: $method, expectedHeadOid: $sha }) { pullRequest { state } } }`, vars);
  let branchError = null;
  if (removeSource && !mr.crossRepo) {
    await rest(ctx, "DELETE", `${repo(ctx)}/git/refs/heads/${refPath(mr.sourceBranch)}`).catch((e) => { branchError = e.message; });
  }
  return { state: STATE[data.mergePullRequest?.pullRequest?.state] ?? "merged", branchError };
}

export async function setDraft(ctx, id, draft) {
  const field = draft ? "convertPullRequestToDraft" : "markPullRequestReadyForReview";
  await graphql(ctx, `mutation($id: ID!) { ${field}(input: { pullRequestId: $id }) { clientMutationId } }`, { id });
}

export const comment = (ctx, iid, body) => rest(ctx, "POST", `${repo(ctx)}/issues/${iid}/comments`, { body });

export const reply = (ctx, _iid, thread, body) => graphql(ctx, `mutation($id: ID!, $body: String!) {
  addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $id, body: $body }) { comment { id } } }`, { id: thread, body });

export async function resolve(ctx, _iid, thread, resolved) {
  const field = resolved ? "resolveReviewThread" : "unresolveReviewThread";
  await graphql(ctx, `mutation($id: ID!) { ${field}(input: { threadId: $id }) { clientMutationId } }`, { id: thread });
}

export const retryJob = (ctx, id) => rest(ctx, "POST", `${repo(ctx)}/actions/jobs/${id}/rerun`);

// A "pipeline" here is one or more workflow runs: each failed one reruns its failed jobs.
export async function retryPipeline(ctx, runs) {
  const failed = (runs ?? []).filter((r) => r.status === "FAILED" || r.status === "CANCELED");
  if (!failed.length) throw new Error("Nothing to retry here: these checks don't come from GitHub Actions");
  for (const r of failed) await rest(ctx, "POST", `${repo(ctx)}/actions/runs/${r.id}/rerun-failed-jobs`);
}

export async function cancelPipeline(ctx, runs) {
  const going = (runs ?? []).filter((r) => ACTIVE.has(r.status));
  if (!going.length) throw new Error("Nothing to cancel here: these checks don't come from GitHub Actions");
  for (const r of going) await rest(ctx, "POST", `${repo(ctx)}/actions/runs/${r.id}/cancel`);
}

// Pushes the branch (a no-op when it's up to date), then opens the pull request.
export async function createMr(ctx, { branch, target, title, description, draft }) {
  const push = await exec("git", ["push", "-u", ctx.remote, branch], { cwd: ctx.root, on: ctx.on });
  if (push.code !== 0) {
    const lines = String(push.stderr || push.stdout).split("\n").map((l) => l.trim()).filter(Boolean);
    throw new Error(lines.find((l) => /^(error|fatal|!)/.test(l)) ?? lines.at(-1) ?? "git push failed");
  }
  return rest(ctx, "POST", `${repo(ctx)}/pulls`, { head: branch, base: target, title, body: description || undefined, draft });
}

// A title and description from the branch's commits, as GitHub would suggest.
export async function draftText(ctx, branch, target) {
  const r = await exec("git", ["log", "--format=%s%x1f%b%x1e", `${ctx.remote}/${target}..${branch}`], { cwd: ctx.root, on: ctx.on });
  const commits = r.code === 0 ? r.stdout.split("\x1e").map((c) => c.trim()).filter(Boolean).map((c) => c.split("\x1f")) : [];
  if (commits.length === 1) return { title: commits[0][0], description: (commits[0][1] ?? "").trim(), count: 1 };
  return { title: commits.at(-1)?.[0] ?? branch, description: commits.map(([s]) => `- ${s}`).reverse().join("\n"), count: commits.length };
}

// ── spaces ───────────────────────────────────────────────────────────────────
// Worktree и агентов панель не создаёт: этим занимается fleet, панель только смотрит и ведёт PR.

export const spaceOnBranch = (branch) => spaces().find((s) => s.branch === branch) ?? null;

// The space on an issue's branch, if one is open.
export const spaceForIssue = (iid) => spaces().find((s) => s.branch?.startsWith(`${iid}-`)) ?? null;
