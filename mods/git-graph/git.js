// Git for the graph, with no herdr imports so node can test it: reading the
// history, the labels on each row and where they sit, and the read-only menus.
// Commands are argv arrays, never a shell line.

// Reads write nothing under .git (no index refresh or lock, no fsmonitor
// cookie), so the folder watch never wakes for the panel's own reads.
export const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
export const STATUS = ["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"];
export const UNCOMMITTED = "*";
// Git's pretty fields are NUL-free strings; -z terminates each seven-field record.
const FORMAT = "%H%x00%P%x00%an%x00%ae%x00%at%x00%D%x00%s";
const objectId = (s) => typeof s === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(s);
const refName = (s) => typeof s === "string" && s.length > 0 && !/^[-/]/.test(s)
  && !/[\x00-\x20\x7f~^:?*\[\\]/.test(s) && !s.includes("..") && !s.includes("@{")
  && s !== "@" && !s.endsWith(".") && s.split("/").every((p) => p && !p.startsWith(".") && !p.endsWith(".lock"));

function checkCommit(commit) {
  if (!objectId(commit?.hash) || !Array.isArray(commit.parents) || !commit.parents.every(objectId)) {
    throw new Error("Invalid commit identity");
  }
}

// a > b for versions like v1.2.3.
export function newer(a, b) {
  const parts = (v) => String(v).replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
}

// `base`: the base branch's full ref (refs/remotes/origin/dev, else refs/heads/dev), or null.
export function logArgs({ all, remotes, limit, base = null }) {
  // All branches walks local branches, tags, remote branches (with Remotes) and HEAD, as other Git tools do.
  // Not `--all`: it also walks the private refs of other tools, such as the per-turn checkpoints of
  // T3 Code (refs/t3/checkpoints/*), which have no label and show up as orphan commits.
  // Otherwise the branch and its base: where it left the base, and what the base has gained since.
  // `--ignore-missing` keeps a repository with no commits (no HEAD yet) an empty log,
  // and a base deleted since it was looked up out of the way.
  const scope = all ? ["--branches", "--tags", ...(remotes ? ["--remotes"] : []), "--ignore-missing", "HEAD"]
    : ["--ignore-missing", "HEAD", ...(base && refName(base) ? [base] : [])];
  return ["log", "-z", ...scope, "--date-order", "--decorate=full", `-n${limit}`, `--format=${FORMAT}`];
}

export function parseRefs(text) {
  const refs = [];
  for (let name of text ? text.split(", ") : []) {
    const head = name.startsWith("HEAD -> ");
    if (head) name = name.slice(8);
    if (name === "HEAD") refs.push({ kind: "detached", name: "HEAD" });
    else if (name.startsWith("refs/heads/") && refName(name.slice(11))) refs.push({ kind: "branch", name: name.slice(11), head });
    else if (name.startsWith("tag: refs/tags/") && refName(name.slice(15))) refs.push({ kind: "tag", name: name.slice(15) });
    else if (name.startsWith("refs/remotes/") && !name.endsWith("/HEAD") && refName(name.slice(13))) refs.push({ kind: "remote", name: name.slice(13) });
  }
  return refs;
}

export function parseLog(text) {
  if (!text) return [];
  const fields = text.split("\0");
  if (fields.pop() !== "" || fields.length % 7 !== 0) throw new Error("Invalid history framing");
  const commits = [];
  for (let i = 0; i < fields.length; i += 7) {
    const [hash, parents, author, email, time, refs, subject] = fields.slice(i, i + 7);
    const parsed = parseRefs(refs);
    const commit = { hash, parents: parents ? parents.split(" ") : [], author, email, time: Number(time), refs: parsed, subject,
      head: parsed.some((r) => r.head || r.kind === "detached") };
    checkCommit(commit);
    if (!/^\d+$/.test(time) || !Number.isSafeInteger(commit.time)) throw new Error("Invalid commit time");
    commits.push(commit);
  }
  return commits;
}

// `git status --porcelain=v1 -z --no-renames`: one NUL-terminated "XY path" per file.
export function parseStatus(text) {
  return text.split("\0").filter(Boolean).map((entry) => {
    const xy = entry.slice(0, 2), path = entry.slice(3);
    const status = xy === "??" ? "A" : xy.includes("U") || xy === "AA" || xy === "DD" ? "U" : xy.includes("D") ? "D" : xy.includes("A") ? "A" : "M";
    // staged: the index differs from HEAD (conflicts aren't staged changes).
    return { path, status, untracked: xy === "??", staged: status !== "U" && xy[0] !== " " && xy[0] !== "?" };
  });
}

// The working tree's changes as the newest row, drawn dashed to HEAD.
export function withUncommitted(commits, changes, head) {
  if (!changes) return commits;
  return [{ hash: UNCOMMITTED, parents: head ? [head] : [], uncommitted: true, dashed: true, refs: [], head: false,
    subject: `Uncommitted changes (${changes})`, author: "", email: "", time: null }, ...commits];
}

// Labels are drawn at these exact widths (monospace text, fixed padding and
// icon), so a press can be matched to the label under it: a virtual list's
// rows can't hold their own handlers.
export const LABEL = { CHAR: 6.6, PAD: 5, ICON: 13, GAP: 6, MAX: 22, FONT: 11 };
const fit = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const partWidth = (part) => Math.ceil(LABEL.PAD * 2 + (part.icon ? LABEL.ICON : 0) + part.text.length * LABEL.CHAR) + 1;

export function labelsOf(commit, remotesShown = true) {
  const labels = [], remotes = remotesShown ? commit.refs.filter((r) => r.kind === "remote") : [], paired = new Set();
  for (const ref of commit.refs) {
    if (ref.kind === "detached") labels.push({ kind: "head", head: true, parts: [{ kind: "head", name: "HEAD", text: "HEAD" }] });
    if (ref.kind !== "branch") continue;
    // A remote branch with the same name rides on its local branch's label, as in Git Graph.
    const parts = [{ kind: "branch", name: ref.name, text: fit(ref.name, LABEL.MAX), icon: true, head: ref.head }];
    for (const remote of remotes) {
      const slash = remote.name.indexOf("/");
      if (remote.name.slice(slash + 1) !== ref.name || paired.has(remote.name)) continue;
      paired.add(remote.name);
      parts.push({ kind: "remote", name: remote.name, text: fit(remote.name.slice(0, slash), 12) });
    }
    labels.push({ kind: "branch", head: ref.head, parts });
  }
  for (const remote of remotes) if (!paired.has(remote.name)) labels.push({ kind: "remote", parts: [{ kind: "remote", name: remote.name, text: fit(remote.name, LABEL.MAX), icon: true }] });
  for (const ref of commit.refs) if (ref.kind === "tag") labels.push({ kind: "tag", parts: [{ kind: "tag", name: ref.name, text: fit(ref.name, LABEL.MAX), icon: true }] });
  // What's checked out comes first.
  labels.sort((a, b) => Number(Boolean(b.head)) - Number(Boolean(a.head)));
  for (const label of labels) {
    for (const part of label.parts) part.width = partWidth(part);
    label.width = label.parts.reduce((n, p) => n + p.width, 2); // + a 1 px border each side
  }
  return labels;
}

// The label part at `x` in a row whose labels start after a `start`-wide graph
// and are cut off at `limit` (the description column's right edge).
export function hitLabel(labels, x, start, limit = Infinity) {
  if (x >= limit) return null;
  let left = start;
  for (const label of labels ?? []) {
    left += LABEL.GAP;
    if (x >= left && x < left + label.width) {
      let at = left + 1;
      for (const part of label.parts) {
        if (x < at + part.width) return { label, part };
        at += part.width;
      }
      return { label, part: label.parts[label.parts.length - 1] };
    }
    left += label.width;
  }
  return null;
}

const item = (label, icon, action) => ({ label, icon, action });
const copy = (label, text) => item(label, "copy", { type: "copy", text });

// The right-click menu for a commit, a label part or a Manygit row. Панели смотрят,
// репозиторий меняет агент: в меню только Fetch, ссылки и копирование, без диалогов
// и команд записи автора, без «New agent tab» и «New terminal tab».
export function menuFor(target, ctx) {
  if (target.kind === "repo") return repoMenu(target, ctx);
  if (target.kind === "uncommitted") return [];
  if (target.kind === "branch" || target.kind === "remote") return [copy("Copy branch name", target.name)];
  if (target.kind === "tag") return [copy("Copy tag name", target.name)];
  return [copy("Copy commit hash", target.commit.hash), copy("Copy commit subject", target.commit.subject)];
}

// A Manygit row: its own Fetch (one repository, on click), its page, its path and branch.
function repoMenu(r, ctx) {
  const branch = r.status?.branch;
  const sections = [
    ctx.remotes.length > 0 ? [item("Fetch", "refresh", { type: "fetch" })] : [],
    [r.web && item(`Open on ${r.web.split("/")[2]}`, "cloud", { type: "openUrl", url: r.web }),
      copy("Copy path", r.path), branch && copy("Copy branch name", branch)].filter(Boolean),
  ];
  return sections.filter((s) => s.length).flatMap((s, i) => (i ? [{ separator: true }, ...s] : s));
}

export const menuHeight = (items) => 10 + items.reduce((n, i) => n + (i.separator ? 9 : 30), 0);

// The git commands an action runs: Fetch is the only one.
export function commandsFor(a) {
  if (a.type === "fetch") return [["fetch", "--all"]];
  throw new Error("Unknown Git action");
}

export const doneText = (a) => (a.type === "fetch" ? "Fetched" : "Done");

// Git's own words, without its hints.
export function gitError(result) {
  const lines = (result.stderr || result.stdout || "").split("\n").map((l) => l.trimEnd()).filter((l) => l && !l.startsWith("hint:"));
  return lines.slice(-6).join("\n") || `git exited with ${result.code}`;
}
