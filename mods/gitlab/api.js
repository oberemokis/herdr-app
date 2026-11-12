// Everything that talks to git and GitLab. GitLab goes through glab (its login, its hosts):
// `glab api graphql` for reading, `glab api` (REST) for most actions.
// `ctx` is plain data, so popups and dialogs get it in their props:
// { host, path, root, on, remote, web, origin, me, main }.

import { exec, setShared, spaces } from "herdr";
import { firstLine, nodes, restId, parseRemote } from "./util.js";

const PIPELINE = `fragment pipeline on Pipeline {
  id iid status ref path createdAt startedAt duration
  detailedStatus { group }
  user { username } commit { shortId title }
  stages { nodes { name jobs { nodes { id name status allowFailure retried retryable webPath duration startedAt } } } }
}`;

const MR = `fragment mr on MergeRequest {
  id iid title state draft webUrl createdAt updatedAt sourceBranch targetBranch detailedMergeStatus userNotesCount
  sourceProjectId targetProjectId resolvableDiscussionsCount resolvedDiscussionsCount
  author { username } reviewers { nodes { username } } approvedBy { nodes { username } }
  userPermissions { canMerge canApprove updateMergeRequest createNote }
  diffStatsSummary { additions deletions fileCount }
}`;

// Список читается двумя запросами: self-hosted GitLab ограничивает сложность одного запроса
// (250 по умолчанию), а вместе MR, пайплайны со стадиями и задачи дают около 290.
const LIST_MRS_QUERY = `query($path: ID!, $branch: String!) {
  currentUser { username todos(state: pending) { count } }
  project(fullPath: $path) {
    webUrl
    repository { rootRef }
    mergeRequests(state: opened, first: 20, sort: UPDATED_DESC) { count nodes { ...mr headPipeline { iid status detailedStatus { group } } } }
    branchMr: mergeRequests(sourceBranches: [$branch], first: 1, sort: CREATED_DESC) { nodes { ...mr headPipeline { ...pipeline } } }
  }
}
${MR}
${PIPELINE}`;

const LIST_PIPELINES_QUERY = `query($path: ID!, $branch: String!) {
  project(fullPath: $path) {
    branchPipelines: pipelines(ref: $branch, first: 1) { nodes { ...pipeline } }
    pipelines(first: 12) { nodes { ...pipeline } }
    issues(state: opened, first: 15, sort: UPDATED_DESC) { count nodes { iid title description webUrl updatedAt author { username } assignees { nodes { username } } labels { nodes { title color } } } }
  }
}
${PIPELINE}`;

const MR_QUERY = `query($path: ID!, $iid: String!) {
  project(fullPath: $path) {
    mergeRequest(iid: $iid) {
      ...mr description diffHeadSha commitCount squash forceRemoveSourceBranch autoMergeEnabled
      headPipeline { ...pipeline }
      diffStats { path additions deletions }
      discussions(first: 100) { nodes { id resolvable resolved notes { nodes { id body system createdAt url author { username } position { filePath newLine oldLine } } } } }
    }
  }
}
${MR}
${PIPELINE}`;

const project = (ctx) => `projects/${encodeURIComponent(ctx.path)}`;

async function glab(ctx, args) {
  const r = await exec("glab", args, { cwd: ctx.root, on: ctx.on }).catch(() => null);
  if (!r) throw new Error("glab isn't installed: https://gitlab.com/gitlab-org/cli");
  return r;
}

// GitLab's message: a string, { field: [reasons] }, a GraphQL error, or glab's own line.
function problem(r, body) {
  const m = body?.errors?.[0]?.message ?? body?.message ?? body?.error;
  if (typeof m === "string") return new Error(m);
  if (m && typeof m === "object") return new Error(Object.entries(m).map(([k, v]) => `${k} ${[].concat(v).join(", ")}`).join("; "));
  return new Error(firstLine(r.stderr || r.stdout) || `glab exited with ${r.code}`);
}

// Strings go as -f (raw), the rest as -F (typed: booleans, numbers).
const fieldArgs = (fields) => Object.entries(fields).filter(([, v]) => v !== undefined && v !== null)
  .flatMap(([k, v]) => [typeof v === "string" ? "-f" : "-F", `${k}=${v}`]);

export async function graphql(ctx, query, vars = {}) {
  const r = await glab(ctx, ["api", "graphql", "--hostname", ctx.host, "-f", `query=${query}`, ...fieldArgs(vars)]);
  let body = null;
  try { body = JSON.parse(r.stdout); } catch { body = null; }
  if (r.code !== 0 || !body?.data || body.errors?.length) throw problem(r, body);
  return body.data;
}

export async function rest(ctx, method, endpoint, fields = {}) {
  const r = await glab(ctx, ["api", "--hostname", ctx.host, "-X", method, endpoint, ...fieldArgs(fields)]);
  let body = null;
  try { body = r.stdout.trim() ? JSON.parse(r.stdout) : null; } catch { body = null; }
  if (r.code !== 0) throw problem(r, body);
  return body;
}

// After an action anywhere (a popup, a dialog), every copy of the panel reloads.
export const bump = () => setShared("gitlab.bump", Date.now());

// The repo a folder belongs to and its GitLab project, from the git remote.
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
  const repo = parseRemote(url.out);
  if (!repo) return { root, error: `Unrecognized remote: ${url.out}` };
  if (/(^|\.)github\.com$/.test(repo.host)) return { root, error: "A GitHub remote: this panel shows GitLab projects" };
  const branch = (await git(["branch", "--show-current"], root)).out;
  return { root, on, remote, host: repo.host, path: repo.path, branch };
}

export async function loadList(ctx, branch) {
  const vars = { path: ctx.path, branch: branch ?? "" };
  const [data, more] = await Promise.all([graphql(ctx, LIST_MRS_QUERY, vars), graphql(ctx, LIST_PIPELINES_QUERY, vars)]);
  if (!data.project || !more.project) return null;
  const p = { ...data.project, ...more.project };
  const branchMr = nodes(p.branchMr)[0] ?? null;
  return {
    web: p.webUrl,
    origin: /^(https?:\/\/[^/]+)/.exec(p.webUrl)?.[1] ?? `https://${ctx.host}`,
    main: p.repository?.rootRef ?? null,
    me: data.currentUser?.username ?? null,
    todos: data.currentUser?.todos?.count ?? 0,
    branchMr,
    branchPipeline: branchMr?.headPipeline ?? nodes(p.branchPipelines)[0] ?? null,
    mrs: nodes(p.mergeRequests), mrCount: p.mergeRequests?.count ?? 0,
    // A [skip ci] commit's pipeline is all noise.
    pipelines: nodes(p.pipelines).filter((x) => x.status !== "SKIPPED"),
    issues: nodes(p.issues), issueCount: p.issues?.count ?? 0,
  };
}

// One merge request with its threads, plus its diffs (REST: the first 100 files).
export async function loadMr(ctx, iid) {
  const [data, diffs] = await Promise.all([
    graphql(ctx, MR_QUERY, { path: ctx.path, iid: String(iid) }),
    rest(ctx, "GET", `${project(ctx)}/merge_requests/${iid}/diffs?per_page=100`).catch((e) => ({ error: e.message })),
  ]);
  const mr = data.project?.mergeRequest;
  if (!mr) throw new Error(`No merge request !${iid}`);
  return { mr, diffs: Array.isArray(diffs) ? diffs : [], diffError: diffs?.error ?? null };
}

// What the merge dialog needs: the MR as it is now and the project's merge settings.
export async function mergeInfo(ctx, iid) {
  const [data, settings] = await Promise.all([
    graphql(ctx, `query($path: ID!, $iid: String!) { project(fullPath: $path) { mergeRequest(iid: $iid) {
      iid title state draft sourceBranch targetBranch diffHeadSha detailedMergeStatus commitCount squash forceRemoveSourceBranch
      headPipeline { status } } } }`, { path: ctx.path, iid: String(iid) }),
    rest(ctx, "GET", project(ctx)),
  ]);
  const mr = data.project?.mergeRequest;
  if (!mr) throw new Error(`No merge request !${iid}`);
  return { mr, settings: settings ?? {} };
}

// ── actions ──────────────────────────────────────────────────────────────────

export const approve = (ctx, iid) => rest(ctx, "POST", `${project(ctx)}/merge_requests/${iid}/approve`);
export const unapprove = (ctx, iid) => rest(ctx, "POST", `${project(ctx)}/merge_requests/${iid}/unapprove`);
export const setState = (ctx, iid, event) => rest(ctx, "PUT", `${project(ctx)}/merge_requests/${iid}`, { state_event: event });

// `sha`: merges only what was reviewed. `auto`: when the pipeline succeeds (both spellings:
// auto_merge since 17.11, merge_when_pipeline_succeeds before).
export const merge = (ctx, iid, { sha, squash, removeSource, auto }) =>
  rest(ctx, "PUT", `${project(ctx)}/merge_requests/${iid}/merge`, {
    sha, squash, should_remove_source_branch: removeSource,
    ...(auto ? { auto_merge: true, merge_when_pipeline_succeeds: true } : {}),
  });

export async function setDraft(ctx, iid, draft) {
  const data = await graphql(ctx, `mutation($path: ID!, $iid: String!, $draft: Boolean!) {
    mergeRequestSetDraft(input: { projectPath: $path, iid: $iid, draft: $draft }) { errors } }`,
  { path: ctx.path, iid: String(iid), draft });
  const errors = data.mergeRequestSetDraft?.errors ?? [];
  if (errors.length) throw new Error(errors[0]);
}

export const comment = (ctx, iid, body) => rest(ctx, "POST", `${project(ctx)}/merge_requests/${iid}/notes`, { body });
export const reply = (ctx, iid, discussion, body) => rest(ctx, "POST", `${project(ctx)}/merge_requests/${iid}/discussions/${restId(discussion)}/notes`, { body });
export const resolve = (ctx, iid, discussion, resolved) => rest(ctx, "PUT", `${project(ctx)}/merge_requests/${iid}/discussions/${restId(discussion)}`, { resolved });

export const retryJob = (ctx, id) => rest(ctx, "POST", `${project(ctx)}/jobs/${restId(id)}/retry`);
export const retryPipeline = (ctx, id) => rest(ctx, "POST", `${project(ctx)}/pipelines/${restId(id)}/retry`);
export const cancelPipeline = (ctx, id) => rest(ctx, "POST", `${project(ctx)}/pipelines/${restId(id)}/cancel`);

// Pushes the branch (a no-op when it's up to date), then opens the merge request.
export async function createMr(ctx, { branch, target, title, description, draft, removeSource }) {
  const push = await exec("git", ["push", "-u", ctx.remote, branch], { cwd: ctx.root, on: ctx.on });
  if (push.code !== 0) {
    const lines = String(push.stderr || push.stdout).split("\n").map((l) => l.trim()).filter(Boolean);
    throw new Error(lines.find((l) => /^(error|fatal|!)/.test(l)) ?? lines.at(-1) ?? "git push failed");
  }
  return rest(ctx, "POST", `${project(ctx)}/merge_requests`, {
    source_branch: branch, target_branch: target, title: draft ? `Draft: ${title}` : title,
    description: description || undefined, remove_source_branch: removeSource,
  });
}

// A title and description from the branch's commits, as GitLab would suggest.
export async function draftText(ctx, branch, target) {
  const r = await exec("git", ["log", "--format=%s%x1f%b%x1e", `${ctx.remote}/${target}..${branch}`], { cwd: ctx.root, on: ctx.on });
  const commits = r.code === 0 ? r.stdout.split("\x1e").map((c) => c.trim()).filter(Boolean).map((c) => c.split("\x1f")) : [];
  if (commits.length === 1) return { title: commits[0][0], description: (commits[0][1] ?? "").trim(), count: 1 };
  return { title: commits.at(-1)?.[0] ?? branch, description: commits.map(([s]) => `- ${s}`).reverse().join("\n"), count: commits.length };
}

// ── spaces ───────────────────────────────────────────────────────────────────
// Worktree и агентов панель не создаёт: этим занимается fleet, панель только смотрит и ведёт MR.

export const spaceOnBranch = (branch) => spaces().find((s) => s.branch === branch) ?? null;

// The space on an issue's branch, if one is open.
export const spaceForIssue = (iid) => spaces().find((s) => s.branch?.startsWith(`${iid}-`)) ?? null;
