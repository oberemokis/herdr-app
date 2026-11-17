// The Remote tab's lists against live hosts, read-only: each mod's loadPage and
// loadSummary, the page cursor, the state filter, no repeated rows; and the Pager
// and the branch merge request rule on fixed data.
//
//   node --import ./scripts/test/hooks.mjs scripts/test/remote-pages.mjs
//
// GitHub: REMOTE_TEST_GITHUB=owner/name (default cli/cli), through gh's login.
// GitLab: REMOTE_TEST_GITLAB=host/group/project, through glab's login; skipped unset.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as gh from "../../mods/github/api.js";
import * as gl from "../../mods/gitlab/api.js";
import { Pager } from "../../mods/gitlab/list.js";

let failed = 0;
async function check(name, fn) {
  try { const note = await fn(); console.log(`ok   ${name}${note ? ` (${note})` : ""}`); }
  catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.message.split("\n").join("\n     ")}`); }
}

const ids = (items) => items.map((x) => x.id);
function noRepeats(items) {
  const seen = new Set();
  for (const id of ids(items)) { assert.ok(!seen.has(id), `row ${id} twice`); seen.add(id); }
}

// Two pages of a list: the second goes on from the first, and every row fits the filter.
async function twoPages(api, ctx, kind, filter, fits) {
  const first = await api.loadPage(ctx, kind, { filter, first: 5 });
  assert.equal(typeof first.count, "number");
  if (!first.next) {
    // Five rows or fewer: nothing to page through here, only the filter to check.
    assert.ok(first.items.length <= 5 && first.items.length <= first.count, `${first.items.length} rows of ${first.count}, and no cursor`);
    for (const x of first.items) assert.ok(fits(x), `${x.id} doesn't fit ${filter}`);
    return `${first.count} in all, one page`;
  }
  const second = await api.loadPage(ctx, kind, { filter, after: first.next, first: 5 });
  const all = [...first.items, ...second.items];
  noRepeats(all);
  for (const x of all) assert.ok(fits(x), `${x.id} doesn't fit ${filter}: ${x.state ?? x.status}`);
}

// ── fixed data ──────────────────────────────────────────────────────────────

await check("list.js is the same file in both mods", () => {
  const read = (mod) => readFileSync(new URL(`../../mods/${mod}/list.js`, import.meta.url), "utf8");
  assert.equal(read("github"), read("gitlab"));
});

await check("branch MR: open from this project before a newer closed one and a fork's", () => {
  const list = [
    { iid: "9", state: "opened", sourceProjectId: 77 }, // a fork's branch of the same name
    { iid: "8", state: "closed", sourceProjectId: 1 },
    { iid: "5", state: "opened", sourceProjectId: 1 },
  ];
  assert.equal(gl.pickBranchMr(list, "gid://gitlab/Project/1")?.iid, "5");
  assert.equal(gl.pickBranchMr(list.slice(0, 2), "gid://gitlab/Project/1")?.iid, "8");
  assert.equal(gl.pickBranchMr(list.slice(0, 1), "gid://gitlab/Project/1"), null);
});

await check("branch PR: open before a newer merged one, never a fork's", () => {
  const list = [
    { number: 9, state: "OPEN", isCrossRepository: true },
    { number: 8, state: "MERGED", isCrossRepository: false },
    { number: 5, state: "OPEN", isCrossRepository: false },
  ];
  assert.equal(gh.pickBranchPr(list)?.number, 5);
  assert.equal(gh.pickBranchPr(list.slice(0, 2))?.number, 8);
  assert.equal(gh.pickBranchPr(list.slice(0, 1)), null);
});

const fakeCx = () => { const jobs = []; const cx = { spawn: (f) => jobs.push(f(cx)), notify() {} }; return { cx, done: async () => { while (jobs.length) await jobs.shift(); } }; };

await check("pager: pages append, a repeated row is dropped, the last page ends it", async () => {
  const pages = { null: { items: [{ id: 1 }, { id: 2 }], next: "a", count: 4 }, a: { items: [{ id: 2 }, { id: 3 }], next: "b" }, b: { items: [{ id: 4 }], next: null } };
  const p = new Pager(async (after) => pages[after]), { cx, done } = fakeCx();
  for (let i = 0; i < 3; i++) { p.more(cx); await done(); }
  assert.deepEqual(ids(p.items), [1, 2, 3, 4]);
  assert.equal(p.done, true); assert.equal(p.count, 4); assert.equal(p.pages, 3);
});

await check("pager: an empty page goes on to the next one", async () => {
  const pages = { null: { items: [], next: "a" }, a: { items: [{ id: 1 }], next: "b" }, b: { items: [{ id: 2 }], next: null } };
  const p = new Pager(async (after) => pages[after]), { cx, done } = fakeCx();
  p.more(cx); await done();
  assert.deepEqual(ids(p.items), [1]);
});

await check("pager: reload reads five pages again and keeps the sixth", async () => {
  let version = 0;
  const load = async (after) => {
    const n = after === null ? 0 : Number(after);
    const items = [{ id: `${n}a`, v: version }, { id: `${n}b`, v: version }];
    return { items, next: n < 6 ? String(n + 1) : null };
  };
  const p = new Pager(load), { cx, done } = fakeCx();
  for (let i = 0; i < 6; i++) { p.more(cx); await done(); }
  version = 1;
  p.reload(cx); await done();
  assert.equal(p.items.length, 12); noRepeats(p.items);
  assert.ok(p.items.slice(0, 10).every((x) => x.v === 1), "the first five pages weren't read again");
  assert.ok(p.items.slice(10).every((x) => x.v === 0), "the sixth page was read again");
  assert.equal(p.next, "6");
});

await check("pager: a failed reload keeps the rows", async () => {
  let fail = false;
  const p = new Pager(async () => { if (fail) throw new Error("boom"); return { items: [{ id: 1 }], next: "x" }; }), { cx, done } = fakeCx();
  p.more(cx); await done();
  fail = true; p.reload(cx); await done();
  assert.deepEqual(ids(p.items), [1]); assert.equal(p.error, "boom");
});

// ── GitHub ──────────────────────────────────────────────────────────────────

const ghPath = process.env.REMOTE_TEST_GITHUB || "cli/cli";
const ghCtx = { host: "github.com", path: ghPath, root: process.cwd(), on: null };
await check(`github ${ghPath}: summary`, async () => {
  const s = await gh.loadSummary(ghCtx, "trunk");
  assert.ok(s, "no repository");
  assert.equal(typeof s.mrCount, "number"); assert.equal(typeof s.issueCount, "number");
  assert.ok(Array.isArray(s.pipelines));
});
for (const [filter, state] of [["open", "opened"], ["merged", "merged"], ["closed", "closed"]]) {
  await check(`github ${ghPath}: pull requests, ${filter}`, () => twoPages(gh, ghCtx, "mrs", filter, (x) => x.state === state));
}
await check(`github ${ghPath}: pull requests, all`, () => twoPages(gh, ghCtx, "mrs", "all", () => true));
for (const [filter, state] of [["open", "OPEN"], ["closed", "CLOSED"]]) {
  await check(`github ${ghPath}: issues, ${filter}`, () => twoPages(gh, ghCtx, "issues", filter, (x) => x.state === state));
}
await check(`github ${ghPath}: workflow runs`, () => twoPages(gh, ghCtx, "pipelines", null, (x) => x.status !== "SKIPPED"));

// ── GitLab ──────────────────────────────────────────────────────────────────

const glWhere = process.env.REMOTE_TEST_GITLAB;
if (!glWhere) console.log("skip gitlab: set REMOTE_TEST_GITLAB=host/group/project");
else {
  const [host, ...rest] = glWhere.split("/"), glCtx = { host, path: rest.join("/"), root: process.cwd(), on: null };
  await check("gitlab: summary", async () => {
    const s = await gl.loadSummary(glCtx, "main");
    assert.ok(s, "no project");
    assert.equal(typeof s.mrCount, "number"); assert.equal(typeof s.issueCount, "number");
  });
  for (const filter of ["open", "merged", "closed"]) {
    const state = { open: "opened", merged: "merged", closed: "closed" }[filter];
    await check(`gitlab: merge requests, ${filter}`, () => twoPages(gl, glCtx, "mrs", filter, (x) => x.state === state));
  }
  await check("gitlab: merge requests, all", () => twoPages(gl, glCtx, "mrs", "all", () => true));
  for (const filter of ["open", "closed"]) {
    const state = { open: "opened", closed: "closed" }[filter];
    await check(`gitlab: issues, ${filter}`, () => twoPages(gl, glCtx, "issues", filter, (x) => x.state === state));
  }
  await check("gitlab: pipelines", () => twoPages(gl, glCtx, "pipelines", null, (x) => x.status !== "SKIPPED"));
}

process.exit(failed ? 1 : 0);
