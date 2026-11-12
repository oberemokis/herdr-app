// Sends a question to the agent working in the reviewed worktree through the
// send dialog (dialog.js, opened as an overlay of this mod: the person adds a
// note and can pick the agent); should the overlay fail to open, the text
// goes straight to an idle agent of that worktree with `hc send --if idle`.
import { agents, panes, terminals, spaces, exec, hc, notify, openOverlay, setShared } from "herdr";

// Комментарии ревью адресованы агенту, который правит этот worktree: чужой агент их не получит.
const isClaude = (a) => a.app === "claude-code" || a.program?.key === "claude";
const cwdOf = (a) => panes().find((p) => p.pane === a.pane)?.cwd ?? terminals().find((t) => t.address === a.address)?.cwd ?? null;

/** Addresses of Claude Code agents whose folder is inside `root` (the reviewed repo's toplevel).
 *  Toplevels are compared for equality: worktrees under .worktrees/ sit inside the main checkout. */
export async function repoAgents(root, on) {
  const out = [];
  for (const a of root ? agents() : []) {
    if (!isClaude(a) || (spaces().find((s) => s.id === a.space)?.machine ?? null) !== (on ?? null)) continue;
    const cwd = cwdOf(a);
    const r = cwd ? await exec("git", ["--no-optional-locks", "rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null) : null;
    if (r?.code === 0 && r.stdout.trim() === root) out.push(a.address);
  }
  return out;
}

/** The `hc send --if` word for a status, or null when nothing may be typed (blocked). */
export const ifFor = (s) => (s === "working" ? "working" : s === "idle" || s === "done" ? "idle" : null);

/** `title`: a short label (the file and lines). `context`: the text the agent gets, already formatted.
 *  `sent`: a shared key the dialog sets to the send time once the text went out.
 *  `root`, `on`: the reviewed repository's toplevel and machine.
 *  Resolves "dialog" (opened), "sent" (sent directly) or "none" (nowhere to send). */
export async function ask({ title, context, sent, root, on }) {
  const addrs = await repoAgents(root, on);
  if (!addrs.length) { notify({ title: "Not sent", body: `No Claude Code agent works in ${root ?? "this folder"}.`, level: "warning" }); return "none"; }
  try { openOverlay({ mod: "reviewer", kind: "dialog", width: context ? 680 : 560, height: context ? 560 : 250, props: { dialog: true, title, context, sent, root, on, agents: addrs } }); return "dialog"; }
  catch (e) { console.log(`the send dialog could not open, sending directly: ${e}`); }
  const agent = agents().find((a) => addrs.includes(a.address) && ifFor(a.status) === "idle");
  if (!agent) { notify({ title: "Not sent", body: "The agent is busy and the send dialog failed to open.", level: "warning" }); return "none"; }
  const r = await hc(["send", "--if", "idle", agent.address, context]).catch((e) => ({ code: 1, stdout: "", stderr: String(e) }));
  if (r.code === 0) {
    notify({ title: `Sent to ${agent.program?.name ?? agent.address}`, body: title, level: "success" });
    if (sent) setShared(sent, Date.now());
    return "sent";
  }
  notify({ title: "Send failed", body: (r.stderr || r.stdout).trim().slice(0, 200), level: "error" });
  return "none";
}
