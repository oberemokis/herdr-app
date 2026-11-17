// Right-click menus as data, and what their items do. A menu opens as a popup copy of this mod
// (props { menu: { items, target, ctx } }); the browser is only ever one of its items.
// Targets are plain data with what their actions need.

import { openOverlay, run, notify } from "herdr";
import * as api from "./api.js";
import { ACTIVE } from "./util.js";
import { MOD } from "./ui.js";

// `gh run view --log` lines: "<job>\t<step>\t<BOM?><timestamp> <text>". Drop the prefix and
// the end-of-group markers; a group start becomes a ▸ heading.
const LOG_SED = [
  String.raw`s/^[^\t]*\t[^\t]*\t(\xef\xbb\xbf)?[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z ?//`,
  String.raw`/^##\[endgroup\]\r?$/d`,
  String.raw`s/^##\[group\]/▸ /`,
  // BSD sed в macOS читает \t, \x.. и \r буквально и молча ничего не удаляет: отдаём сами байты.
].join("\n").replaceAll("\\t", "\t").replaceAll("\\xef\\xbb\\xbf", "﻿").replaceAll("\\r", "\r");

// A GitHub Actions job's log in a terminal below the focused pane; it stays until Enter.
// gh gives the log only once the job's run has finished.
// Without a sed that takes -u (BusyBox), the log goes through raw.
export function showLog(ctx, job) {
  const script = 'gh run view --job "$1" --log -R "$2" 2>&1 | { sed -uE "$4" 2>/dev/null || cat; }; printf "\\n\\033[2m— end of %s, Enter closes —\\033[0m" "$3"; read _';
  run("terminal.open", { argv: ["sh", "-c", script, "sh", job.id, `${ctx.host}/${ctx.path}`, job.name, LOG_SED], folder: ctx.root, place: "down", name: `log ${job.name}` });
}

const item = (id, label, icon, extra = {}) => ({ id, label, icon, ...extra });
const SEP = { sep: true };

// What a pull request's actions need.
export const mrTarget = (mr) => ({
  id: mr.id, iid: mr.iid, title: mr.title, url: mr.webUrl, branch: mr.sourceBranch, sourceBranch: mr.sourceBranch,
  review: mr.myApproval ?? null,
});

export function mrItems(mr, ctx) {
  const open = mr.state === "opened", perm = mr.userPermissions ?? {};
  const approved = (mr.approvedBy?.nodes ?? []).some((u) => u.username === ctx.me);
  return [
    ...(open && perm.canApprove && !approved ? [item("approve", "Approve", "check")] : []),
    ...(open && approved && perm.canDismiss && mr.myApproval ? [item("unapprove", "Dismiss your approval", "x")] : []),
    ...(open && perm.canMerge ? [item("merge", "Merge…", "merged")] : []),
    ...(open && perm.updateMergeRequest ? [mr.draft ? item("ready", "Mark as ready", "draft") : item("draft", "Mark as draft", "draft")] : []),
    SEP,
    item("copy-branch", "Copy branch name", "copy"),
    item("copy-link", "Copy link", "link"),
    item("open", "Open on GitHub", "external"),
    ...(perm.updateMergeRequest && open ? [SEP, item("close", "Close pull request…", "x", { danger: true })] : []),
    ...(perm.updateMergeRequest && mr.state === "closed" ? [SEP, item("reopen", "Reopen", "reopen")] : []),
  ];
}

const hasRuns = (p) => (p.runs ?? []).length > 0;

export function pipelineItems(p) {
  return [
    ...(hasRuns(p) && (p.status === "FAILED" || p.status === "CANCELED") ? [item("retry-pipeline", "Re-run failed jobs", "retry")] : []),
    ...(hasRuns(p) && ACTIVE.has(p.status) ? [item("cancel-pipeline", "Cancel run", "stop", { danger: true })] : []),
    SEP,
    item("copy-link", "Copy link", "link"),
    item("open", "Open on GitHub", "external"),
  ];
}

export const pipelineTarget = (p) => ({ id: p.id, url: p.url, runs: p.runs ?? [] });

export function jobItems(job) {
  return [
    ...(job.log ? [item("log", "Show log", "terminal")] : []),
    ...(job.retryable ? [item("retry-job", "Re-run", "retry")] : []),
    ...(job.url ? [SEP, item("copy-link", "Copy link", "link"), item("open", "Open on GitHub", "external")] : []),
  ];
}

export const linkItems = () => [item("copy-link", "Copy link", "link"), item("open", "Open on GitHub", "external")];

// What an issue's actions need: the space already on its branch, if any.
export const issueTarget = (issue) => ({
  iid: issue.iid, title: issue.title, description: issue.description ?? "", url: issue.webUrl,
  space: api.spaceForIssue(issue.iid)?.id ?? null,
});

// Worktree под задачу и агента заводит fleet; отсюда только переход в уже открытое пространство.
export function issueItems(target) {
  return [
    ...(target.space ? [item("goto", "Go to worktree", "folder"), SEP] : []),
    ...linkItems(),
  ];
}

export function threadItems(thread) {
  return [
    ...(thread.resolvable && thread.canResolve ? [thread.resolved ? item("unresolve", "Unresolve thread", "reopen") : item("resolve", "Resolve thread", "check")] : []),
    SEP,
    ...linkItems(),
  ];
}

export const fileItems = () => [item("copy-path", "Copy path", "copy"), item("open", "Open diff on GitHub", "external")];

export function projectItems(ctx) {
  return [
    item("open", "Open repository on GitHub", "external", { url: ctx.web }),
    item("open", "Pull requests on GitHub", "merge-request", { url: `${ctx.web}/pulls` }),
    item("open", "Actions on GitHub", "pipeline", { url: `${ctx.web}/actions` }),
    item("open", "Issues on GitHub", "issue", { url: `${ctx.web}/issues` }),
    item("open", "Your review requests", "check", { url: `${ctx.origin}/pulls/review-requested` }),
  ];
}

export function openMenu(items, target, ctx) {
  const clean = items.filter((x, i, all) => !(x.sep && (i === 0 || all[i - 1].sep || i === all.length - 1)));
  const rows = clean.filter((x) => !x.sep).length, seps = clean.length - rows;
  openOverlay({ mod: MOD, kind: "popup", width: 236, height: 12 + rows * 31 + seps * 9, props: { menu: { items: clean, target, ctx } } });
}

export function openDialog(kind, target, ctx) {
  const [width, height] = { merge: [440, 340], close: [400, 200], create: [480, 300] }[kind];
  openOverlay({ mod: MOD, kind: "dialog", width, height, props: { dialog: { kind, target, ctx } } });
}

const copied = (cx, text) => {
  cx.write_to_clipboard(text);
  notify({ title: "Copied", body: text, level: "info", timeout: 1500 });
};

// Slow items: run while the popup shows a spinner, then it closes and the panel reloads.
const ACTIONS = {
  approve: (ctx, t) => api.approve(ctx, t.iid),
  unapprove: (ctx, t) => api.unapprove(ctx, t.iid, t.review),
  ready: (ctx, t) => api.setDraft(ctx, t.id, false),
  draft: (ctx, t) => api.setDraft(ctx, t.id, true),
  reopen: (ctx, t) => api.setState(ctx, t.iid, "reopen"),
  "retry-job": (ctx, t) => api.retryJob(ctx, t.id),
  "retry-pipeline": (ctx, t) => api.retryPipeline(ctx, t.runs),
  "cancel-pipeline": (ctx, t) => api.cancelPipeline(ctx, t.runs),
  resolve: (ctx, t) => api.resolve(ctx, t.iid, t.discussion, true),
  unresolve: (ctx, t) => api.resolve(ctx, t.iid, t.discussion, false),
};

export const isSlow = (id) => id in ACTIONS;
export const work = (it, target, ctx) => ACTIONS[it.id](ctx, target);

// Runs a quick item: a link, a copy, a log, or a dialog.
export function choose(it, target, ctx, cx) {
  switch (it.id) {
    case "open": cx.open_url(it.url ?? target.url); break;
    case "copy-link": copied(cx, target.url); break;
    case "copy-branch": copied(cx, target.branch); break;
    case "copy-path": copied(cx, target.path); break;
    case "log": showLog(ctx, target); break;
    case "merge": case "close": case "create": openDialog(it.id, target, ctx); break;
    case "goto": run("space.select", { id: target.space }); break;
  }
}
