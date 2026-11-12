// Pure helpers: time, statuses, remotes, diffs. No Herdr or GPUI calls here.

// Statuses that can still change, and the notification for each way a pipeline ends.
export const ACTIVE = new Set(["CREATED", "WAITING_FOR_RESOURCE", "PREPARING", "PENDING", "RUNNING", "SCHEDULED", "WAITING_FOR_CALLBACK", "CANCELING"]);
export const ENDED = { SUCCESS: ["Pipeline passed", "success"], FAILED: ["Pipeline failed", "error"], CANCELED: ["Pipeline canceled", "warning"] };

export const nodes = (c) => c?.nodes ?? [];
// gid://gitlab/Ci::Build/1174 → 1174, gid://gitlab/Discussion/<sha> → <sha>.
export const restId = (gid) => String(gid ?? "").split("/").pop();

// The line that says what went wrong: glab boxes errors under an "ERROR" heading.
export const firstLine = (s) => String(s ?? "").replace(/\x1b\[[0-9;]*m/g, "").split("\n")
  .map((l) => l.trim().replace(/^glab:\s*/, "")).find((l) => l && !/^error:?$/i.test(l)) ?? "";

export const refLabel = (p) => {
  const mr = /^refs\/merge-requests\/(\d+)\//.exec(p?.ref ?? "");
  return mr ? `!${mr[1]}` : p?.ref ?? "";
};

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

// git@host:group/repo.git, ssh://git@host:22/group/repo.git, https://host/group/repo.git
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
