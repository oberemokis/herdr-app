// Pure helpers: time, statuses, remotes, diffs. No Herdr or GPUI calls here.

// Statuses that can still change, and the notification for each way a run ends.
export const ACTIVE = new Set(["PENDING", "RUNNING"]);
export const ENDED = { SUCCESS: ["passed", "success"], FAILED: ["failed", "error"], CANCELED: ["canceled", "warning"] };

export const nodes = (c) => c?.nodes ?? [];
// Anything as an element id: check names carry slashes and spaces.
export const slug = (s) => String(s ?? "").replace(/[^A-Za-z0-9_-]/g, "_");

// The line that says what went wrong, without gh's "gh: " prefix.
export const firstLine = (s) => String(s ?? "").replace(/\x1b\[[0-9;]*m/g, "").split("\n")
  .map((l) => l.trim().replace(/^gh:\s*/, "")).find((l) => l && !/^error:?$/i.test(l)) ?? "";

// A check run or workflow run (GraphQL upper case, REST lower case) as one status word.
export function checkStatus(status, conclusion) {
  const s = String(status ?? "").toUpperCase(), c = String(conclusion ?? "").toUpperCase();
  if (s && s !== "COMPLETED") return s === "IN_PROGRESS" ? "RUNNING" : "PENDING";
  switch (c) {
    case "SUCCESS": return "SUCCESS";
    case "FAILURE": case "TIMED_OUT": case "STARTUP_FAILURE": return "FAILED";
    case "CANCELLED": return "CANCELED";
    case "ACTION_REQUIRED": return "MANUAL";
    case "SKIPPED": case "NEUTRAL": case "STALE": return "SKIPPED";
    default: return "CREATED";
  }
}

// A commit status from an outside service (the older Statuses API).
export function contextStatus(state) {
  switch (state) {
    case "SUCCESS": return "SUCCESS";
    case "FAILURE": case "ERROR": return "FAILED";
    case "PENDING": case "EXPECTED": return "PENDING";
    default: return "CREATED";
  }
}

// Many statuses as one: anything still going wins, then failures.
export function rollup(list) {
  for (const s of ["RUNNING", "PENDING", "FAILED", "CANCELED", "MANUAL"]) if (list.includes(s)) return s;
  if (list.length && list.every((s) => s === "SKIPPED")) return "SKIPPED";
  return list.length ? "SUCCESS" : "CREATED";
}

export const seconds = (from, to) => (from && to ? Math.max(0, (Date.parse(to) - Date.parse(from)) / 1000) : null);

export function ago(iso) {
  if (!iso) return "";
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 14 * 86400) return `${Math.floor(s / 86400)}d`;
  return `${Math.floor(s / (7 * 86400))}w`;
}

export function span(sec) {
  if (sec == null) return "";
  sec = Math.round(sec);
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m ${sec % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

// How long it took, or for how long it has been going.
export const took = (x) => (x.duration != null ? span(x.duration) : ACTIVE.has(x.status) && x.startedAt ? span((Date.now() - Date.parse(x.startedAt)) / 1000) : "");

// git@host:owner/repo.git, ssh://git@host:22/owner/repo.git, https://host/owner/repo.git
export function parseRemote(url) {
  url = url.trim();
  let m = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+?)(?:\.git)?\/?$/.exec(url);
  if (m && !url.includes("://")) return { host: m[1], path: m[2] };
  m = /^[a-z+]+:\/\/(?:[^@/]+@)?([^:/]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/.exec(url);
  return m ? { host: m[1], path: m[2] } : null;
}

// A unified diff as rows numbered once, so a frame draws only the rows on screen.
export function diffRows(text) {
  const lines = String(text ?? "").replace(/\n$/, "").split("\n").slice(0, 4000);
  let old = 0, next = 0;
  return lines.map((line) => {
    if (line.length > 4000) line = `${line.slice(0, 4000)}… (line truncated)`;
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (m) { old = +m[1]; next = +m[2]; return { kind: "@", text: line }; }
    const kind = line[0];
    if (kind === "-") return { kind, number: old++, text: line.slice(1) || " " };
    if (kind === "+") return { kind, number: next++, text: line.slice(1) || " " };
    if (kind === " ") { old++; return { kind, number: next++, text: line.slice(1) || " " }; }
    return { kind: "", text: line };
  });
}

// +/- counts of a unified diff.
export function diffCounts(text) {
  let add = 0, del = 0;
  for (const line of String(text ?? "").split("\n")) {
    if (line.startsWith("+")) add++;
    else if (line.startsWith("-")) del++;
  }
  return { add, del };
}
