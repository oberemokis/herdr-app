// Parsers for the macOS command output that the panel samples. No Herdr imports,
// so tests can load this file with plain Node.

const GIB = 2 ** 30;

// `iostat -n 0 -c 2 -w 1`: the first row counts from boot, the last one covers the last second.
export const SCRIPT = [
  "echo @cpu; iostat -n 0 -c 2 -w 1",
  "echo @vm; vm_stat",
  "echo @sys; sysctl -n hw.memsize kern.memorystatus_vm_pressure_level vm.swapusage hw.ncpu",
  "echo @df; df -k /",
  "echo @batt; pmset -g batt",
  // Bytes through the physical interfaces since boot; VPN tunnels (utun) would count the same traffic twice.
  "echo @net; netstat -ibn | awk '$3 ~ /^<Link#/ && $1 ~ /^en[0-9]/ { i += $(NF-4); o += $(NF-1) } END { printf \"%.0f %.0f\\n\", i, o }'",
].join("; ");

// Asked only while the pointer is on the CPU row: `ps` reads every process.
export const PROCS = "ps -Aceo pcpu=,comm= -r | head -n 6";

// The monitor window's process table: every process with its parent, to find Herdr's tree.
export const TREE = "ps -axo pid=,ppid=,pcpu=,rss=,comm=";
// Asked once when the monitor opens.
export const HOST = "scutil --get ComputerName 2>/dev/null || hostname -s; sysctl -n kern.boottime";

export function parse(out) {
  const part = (name) => out.split(`@${name}\n`)[1]?.split("\n@")[0] ?? "";

  const cpuRow = part("cpu").trim().split("\n").at(-1)?.trim().split(/\s+/) ?? [];
  const idle = cpuRow.length >= 3 && /^\d+$/.test(cpuRow[2]) ? Number(cpuRow[2]) : null;

  const vm = part("vm");
  const pageSize = Number(vm.match(/page size of (\d+)/)?.[1] ?? 16384);
  const pages = (label) => Number(vm.match(new RegExp(`${label}:\\s+(\\d+)`))?.[1] ?? 0);
  // Activity Monitor's "Memory Used": app memory + wired + compressed.
  const used = (pages("Anonymous pages") - pages("Pages purgeable") + pages("Pages wired down") + pages("Pages occupied by compressor")) * pageSize;

  const [memsize, pressure, swap = "", ncpu] = part("sys").split("\n");
  const load = cpuRow.length >= 4 && /^[\d.]+$/.test(cpuRow[3]) ? Number(cpuRow[3]) : null;
  const [rxTotal, txTotal] = part("net").trim().split(/\s+/).map(Number);
  const swapUsed = swap.match(/used = ([\d.]+)([MG])/);

  const df = part("df").trim().split("\n").at(-1)?.split(/\s+/) ?? [];
  const batt = part("batt");
  const level = batt.match(/(\d+)%;\s*([^;]+)/);

  return {
    cpu: idle === null ? null : Math.max(0, Math.min(100, 100 - idle)),
    mem: { used, total: Number(memsize) || 0, pressure: Number(pressure) || 1 },
    swap: swapUsed ? Number(swapUsed[1]) * (swapUsed[2] === "G" ? GIB : 2 ** 20) : 0,
    disk: df.length > 3 ? { total: Number(df[1]) * 1024, free: Number(df[3]) * 1024 } : null,
    battery: level ? { pct: Number(level[1]), state: level[2].trim(), ac: batt.includes("AC Power") } : null,
    cores: Number(ncpu) || 1,
    load,
    net: Number.isFinite(rxTotal) && Number.isFinite(txTotal) ? { rx: rxTotal, tx: txTotal } : null,
  };
}

// The agents people run in Herdr's terminals, by executable name ("codex-0.169.0-…" too).
const AGENT = /^(claude|codex|opencode|gemini|aider|amp|goose|crush|qwen|cursor-agent|droid|kiro|pi)([-.]|$)/i;
const isHerdr = (p) => p?.name === "Herdr" || p?.name === "herdr-core";

// `ps -axo pid=,ppid=,pcpu=,rss=,comm=` → Herdr's own processes and everything under them.
// kind: "herdr" (the app and herdr-core), "agent" (an agent itself), "tool" (anything an agent
// started), "shell" (the rest of a terminal: shells, servers, builds). Helpers the app's mods run
// (this table's own `ps`, git, scripts) are children of the app itself and are left out.
export function parseTree(out) {
  const all = new Map();
  const kids = new Map();
  for (const line of out.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(.+?)\s*$/);
    if (!m) continue;
    const p = { pid: Number(m[1]), ppid: Number(m[2]), cpu: Number(m[3]), mem: Number(m[4]) * 1024, name: m[5].split("/").pop() };
    all.set(p.pid, p);
    if (!kids.has(p.ppid)) kids.set(p.ppid, []);
    kids.get(p.ppid).push(p.pid);
  }
  const found = [];
  const seen = new Set();
  const walk = (pid, parent) => {
    const p = all.get(pid);
    if (!p || seen.has(pid)) return;
    seen.add(pid);
    if (parent?.name === "Herdr" && !isHerdr(p)) return;
    const kind = isHerdr(p) ? "herdr" : AGENT.test(p.name) ? "agent" : parent?.kind === "agent" || parent?.kind === "tool" ? "tool" : "shell";
    const row = { ...p, kind };
    found.push(row);
    for (const child of kids.get(pid) ?? []) walk(child, row);
  };
  for (const p of all.values()) if (isHerdr(p) && !isHerdr(all.get(p.ppid))) walk(p.pid, null);
  return found;
}

export const GROUPS = { herdr: "herdr", agent: "agents", tool: "agents", shell: "terminals" };

// `scutil --get ComputerName; sysctl -n kern.boottime` → { host, boot (ms) }.
export function parseHost(out) {
  const [host = "", boot = ""] = out.split("\n");
  const sec = boot.match(/sec = (\d+)/)?.[1];
  return { host: host.trim(), boot: sec ? Number(sec) * 1000 : null };
}

const units = (value, steps) => {
  let i = 0;
  while (value >= 1000 && i < steps.length - 1) { value /= 1024; i++; }
  return `${value >= 100 || i === 0 ? Math.round(value) : Math.round(value * 10) / 10} ${steps[i]}`;
};
export const bytes = (b) => units(b, ["Б", "КБ", "МБ", "ГБ", "ТБ"]);
export const rate = (b) => `${units(b ?? 0, ["Б", "КБ", "МБ", "ГБ"])}/с`;

// `ps -Aceo pcpu=,comm= -r`: the busiest processes, without the ones this panel started.
export function parseProcs(out, count = 3) {
  return out.split("\n")
    .map((l) => l.match(/^\s*([\d.]+)\s+(.+?)\s*$/))
    .filter((m) => m && !["ps", "head", "sh"].includes(m[2]))
    .slice(0, count)
    .map((m) => ({ name: m[2], cpu: Number(m[1]) }));
}

export const gb = (bytes) => String(bytes / GIB >= 100 ? Math.round(bytes / GIB) : Math.round((bytes / GIB) * 10) / 10);
