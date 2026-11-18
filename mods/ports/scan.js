// Parses scan.sh: who listens on which TCP port, where it was started, and from which
// git worktree. Pure functions, no herdr imports, so `node` can run them on a saved scan.

// Splits the script's output into its "@name" sections.
function sections(out) {
  const got = {};
  let cur = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("@")) { cur = line.slice(1).trim(); got[cur] = []; continue; }
    if (cur && line) got[cur].push(line);
  }
  return got;
}

// "*:3000", "127.0.0.1:5432", "[::1]:8080" -> { host, port }
function address(n) {
  const i = n.lastIndexOf(":");
  if (i < 0) return null;
  const port = Number(n.slice(i + 1));
  if (!Number.isInteger(port)) return null;
  return { host: n.slice(0, i).replace(/^\[|\]$/g, ""), port };
}

const LOOPBACK = /^(127\.|::1$|localhost$)/;

// "mm:ss", "hh:mm:ss" or "dd-hh:mm:ss" -> seconds
export function etime(s) {
  const [d, rest] = s.includes("-") ? s.split("-") : ["0", s];
  const parts = rest.split(":").map(Number);
  while (parts.length < 3) parts.unshift(0);
  const [h, m, sec] = parts;
  return ((Number(d) * 24 + h) * 60 + m) * 60 + sec;
}

// The process a Docker VM publishes container ports through.
const VM = /^(OrbStack|com\.docker|vpnkit|docker|limactl|gvproxy)/i;
const HERDR = /herdr-core|^Herdr$|\/Herdr$/;

export function parse(out) {
  const s = sections(out);

  // lsof -F: p<pid>, c<command>, f<fd>, n<address>
  const seen = new Map();
  let pid = null, cmd = null;
  for (const line of s.lsof ?? []) {
    const k = line[0], v = line.slice(1);
    if (k === "p") pid = Number(v);
    else if (k === "c") cmd = v;
    else if (k === "n" && pid) {
      const a = address(v);
      if (!a) continue;
      const key = `${pid}:${a.port}`;
      const row = seen.get(key) ?? { pid, port: a.port, name: cmd, hosts: [] };
      if (!row.hosts.includes(a.host)) row.hosts.push(a.host);
      seen.set(key, row);
    }
  }

  const ps = new Map();
  for (const line of s.ps ?? []) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    if (m) ps.set(Number(m[1]), { ppid: Number(m[2]), age: etime(m[3]), command: m[4] });
  }

  const cwd = new Map();
  pid = null;
  for (const line of s.cwd ?? []) {
    if (line[0] === "p") pid = Number(line.slice(1));
    else if (line[0] === "n" && pid) cwd.set(pid, line.slice(1));
  }

  const tree = new Map();
  for (const line of s.tree ?? []) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (m) tree.set(Number(m[1]), { ppid: Number(m[2]), comm: m[3] });
  }
  // Started from a Herdr terminal: herdr-core is an ancestor. The app itself is "self".
  const origin = (p) => {
    if (HERDR.test(tree.get(p)?.comm ?? "")) return "self";
    for (let q = tree.get(p)?.ppid, n = 0; q > 1 && n < 64; q = tree.get(q)?.ppid, n++) {
      if (HERDR.test(tree.get(q)?.comm ?? "")) return "herdr";
    }
    return null;
  };

  // Published ports of running containers: "0.0.0.0:9000-9001->9000-9001/tcp, [::]:8000->8000/tcp".
  const docker = new Map();
  const gone = new Set(s.gone ?? []);
  for (const line of s.docker ?? []) {
    const [name, project, dir, ports = ""] = line.split("|");
    for (const spec of ports.split(", ")) {
      const m = spec.match(/^(.*):(\d+)(?:-(\d+))?->/);
      if (!m) continue;
      for (let port = Number(m[2]); port <= Number(m[3] ?? m[2]); port++) {
        docker.set(port, { name, project: project || null, dir: dir || null, gone: gone.has(dir) });
      }
    }
  }

  // Only the user's own checkouts count: Homebrew and the home folder itself are git repos too.
  const home = (s.home ?? [])[0] ?? "";
  const git = new Map();
  for (const line of s.git ?? []) {
    const [dir, top, common, branch] = line.split("|");
    if (!home || top === home || !top.startsWith(home + "/")) continue;
    const main = common.replace(/\/\.git\/?$/, "");
    git.set(dir, {
      top, branch: branch === "HEAD" ? null : branch,
      repo: base(common.endsWith(".git") ? main : common),
      worktree: top === main ? null : base(top),
    });
  }

  const rows = [...seen.values()].map((r) => {
    const p = ps.get(r.pid);
    const container = VM.test(r.name ?? "") ? docker.get(r.port) ?? null : null;
    const dir = container?.dir ?? cwd.get(r.pid) ?? null;
    return {
      ...r,
      container,
      local: r.hosts.every((h) => LOOPBACK.test(h)),
      age: p?.age ?? null,
      command: p?.command ?? r.name,
      cwd: dir,
      git: dir ? git.get(dir) ?? null : null,
      origin: origin(r.pid),
    };
  });

  // The same port held by more than one process: a stale server next to a new one.
  const holders = new Map();
  for (const r of rows) holders.set(r.port, (holders.get(r.port) ?? 0) + 1);
  for (const r of rows) r.clash = holders.get(r.port) > 1;

  return rows.sort((a, b) => a.port - b.port);
}

export function base(path) {
  return path.replace(/\/+$/, "").split("/").pop() || path;
}

// Development: started from a Herdr terminal, or running inside some folder. System daemons
// and apps launched from the Dock run in "/".
export const isDev = (r) => r.origin === "herdr" || r.container !== null || (r.cwd !== null && r.cwd !== "/");

// The nearest port at or above `from` nobody listens on.
export function freeFrom(from, rows) {
  const busy = new Set(rows.map((r) => r.port));
  for (let p = from; p < 65536; p++) if (!busy.has(p)) return p;
  return null;
}

export function age(sec) {
  if (sec === null) return "";
  if (sec < 60) return `${sec} с`;
  if (sec < 3600) return `${Math.floor(sec / 60)} мин`;
  if (sec < 86400) return `${Math.floor(sec / 3600)} ч ${Math.floor((sec % 3600) / 60)} мин`;
  return `${Math.floor(sec / 86400)} д ${Math.floor((sec % 86400) / 3600)} ч`;
}
