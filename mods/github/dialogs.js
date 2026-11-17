// Dialogs opened as copies of this mod (props { dialog: { kind, target, ctx } }):
// merge (with its method and options), close (a confirm), create (a new pull request).
// Диалоги worktree и review убраны: worktree и агентов заводит fleet.
// Enter confirms, Esc closes. Each runs its action itself, then the panel reloads.

import { div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { props, closeOverlay, notify, theme } from "herdr";
import * as api from "./api.js";
import { pill, toggle, mergeStatus } from "./ui.js";

// What GitHub can merge right away, and what auto-merge can wait for.
const CAN_MERGE = new Set(["MERGEABLE", "UNSTABLE", "BEHIND"]);
const CAN_WAIT = new Set(["CI_STILL_RUNNING", "NOT_APPROVED", "BLOCKED_STATUS", "CHECKING"]);
const METHOD = { MERGE: "Merge commit", SQUASH: "Squash", REBASE: "Rebase" };

export class Dialog {
  constructor(spec, cx) {
    this.kind = spec.kind; this.target = spec.target; this.ctx = spec.ctx;
    this.handle = cx.focus_handle();
    this.handle.focus();
    this.busy = false; this.error = ""; this.ready = false;
    if (this.kind === "merge") this.loadMerge(cx);
    if (this.kind === "create") this.loadCreate(cx);
    if (this.kind === "close") this.ready = true;
  }

  close() { closeOverlay(props().overlay); }

  loadMerge(cx) {
    cx.spawn(async (cx) => {
      try {
        const { mr, settings } = await api.mergeInfo(this.ctx, this.target.iid);
        this.mr = mr; this.settings = settings;
        this.method = settings.methods.includes(settings.preferred) ? settings.preferred : settings.methods[0];
        this.removeSource = !mr.crossRepo;
        this.auto = settings.autoMergeAllowed && CAN_WAIT.has(mr.detailedMergeStatus);
        this.ready = true;
      } catch (e) { this.error = e.message; }
      cx.notify();
    });
  }

  loadCreate(cx) {
    this.input = InputState.new({ placeholder: "Title" });
    this.input.on("submit", (_e, cx) => this.confirm(cx));
    this.input.on("change", (_e, cx) => cx.notify());
    this.draft = false;
    cx.timer.after(600, () => this.input.focus());
    cx.spawn(async (cx) => {
      try {
        const text = await api.draftText(this.ctx, this.target.branch, this.target.into);
        this.description = text.description; this.commits = text.count;
        if (!this.input.value()) this.input.set_value(text.title);
      } catch (e) { this.error = e.message; }
      this.ready = true;
      cx.notify();
    });
  }

  canConfirm() {
    if (!this.ready || this.busy) return false;
    if (this.kind === "merge") {
      const s = this.mr?.detailedMergeStatus;
      return this.mr?.state === "opened" && Boolean(this.method) && (this.auto ? CAN_WAIT.has(s) : CAN_MERGE.has(s));
    }
    if (this.kind === "create") return this.commits > 0 && Boolean(this.input?.value().trim());
    return true;
  }

  confirm(cx) {
    if (!this.canConfirm()) return;
    this.busy = true; this.error = "";
    cx.spawn(async (cx) => {
      try {
        const done = await this.act();
        api.bump();
        if (done) notify({ title: done.title, body: done.body, level: done.level ?? "success", timeout: 4000 });
        this.close();
      } catch (e) { this.error = e.message; this.busy = false; }
      cx.notify();
    });
    cx.notify();
  }

  // Does it; returns what the notification says.
  async act() {
    const { ctx, target } = this;
    if (this.kind === "close") { await api.setState(ctx, target.iid, "close"); return { title: `Closed #${target.iid}` }; }
    if (this.kind === "merge") {
      const r = await api.merge(ctx, this.mr, { method: this.method, removeSource: this.removeSource && !this.settings.deleteBranchOnMerge, auto: this.auto });
      if (r.state === "auto") return { title: `#${target.iid} merges when it's ready` };
      if (r.branchError) return { title: `Merged #${target.iid}`, body: `The branch stays: ${r.branchError}`, level: "warning" };
      return { title: `Merged #${target.iid}` };
    }
    const pr = await api.createMr(ctx, { branch: target.branch, target: target.into, title: this.input.value().trim(), description: this.description, draft: this.draft });
    return { title: `Opened #${pr?.number ?? ""}` };
  }

  frame(t, title, body, button, tone = "solid") {
    const p = props();
    return v_flex().id("gh-dialog").track_focus(this.handle).size_full().min_h(0).p(18).gap(10).bg(t.popover).text_size(13).text_color(t.foreground)
      .on_key_down((e, cx) => {
        if (e.key === "enter") this.confirm(cx);
        else if (e.key === "escape") closeOverlay(p.overlay);
        else return;
        cx.stop_propagation();
      })
      .child(h_flex().items_center().child(div().flex_1().min_w(0).truncate().text_size(15).font_semibold().child(title)).child(div().text_size(11).text_color(t.dim).child("Esc")))
      .child(v_flex().flex_1().min_h(0).gap(8).children(body))
      .when(Boolean(this.error), (el) => el.child(div().text_size(12).text_color(t.ansi1).child(this.error)))
      .child(h_flex().justify_end().gap(8)
        .child(pill("gh-cancel", "Cancel", t, { onClick: () => this.close() }))
        .child(pill("gh-confirm", button, t, { tone, busy: this.busy, disabled: !this.canConfirm(), onClick: (cx) => this.confirm(cx) })));
  }

  // The merge methods the repository allows, as a row of buttons.
  methods(t) {
    return h_flex().gap(6).children(this.settings.methods.map((m) => pill(`gh-method-${m}`, METHOD[m], t, {
      tone: m === this.method ? "solid" : "plain", onClick: (cx) => { this.method = m; cx.notify(); },
    })));
  }

  render(cx) {
    const t = theme(), target = this.target;
    const muted = (text) => div().text_size(12.5).text_color(t.muted).child(text);
    if (this.kind === "close") {
      return this.frame(t, `Close #${target.iid}?`, [muted(target.title), muted("The pull request closes; its branch stays, and it can be reopened.")], "Close", "danger");
    }
    const field = () => h_flex().h(34).px(10).items_center().rounded(7).border_1().border_color(t.input).bg(t.background)
      .child(Input.new(this.input).w_full().text_size(13).text_color(t.foreground));
    if (this.kind === "create") {
      return this.frame(t, "New pull request", [
        muted(`${target.branch} → ${target.into}${this.commits ? ` · ${this.commits} commit${this.commits === 1 ? "" : "s"}` : ""}`),
        field(),
        toggle("gh-draft", "Draft", this.draft, t, { onChange: (v, cx) => { this.draft = v; cx.notify(); } }),
        this.ready && !this.commits
          ? div().text_size(12).text_color(t.ansi3).child(`No commits ahead of ${target.into} yet.`)
          : div().text_size(11.5).text_color(t.dim).child(`Pushes ${target.branch} to ${this.ctx.remote} first; the description comes from its commits.`),
      ], "Create");
    }
    // merge
    const mr = this.mr;
    if (!mr) return this.frame(t, `Merge #${target.iid}`, [muted(this.error ? "" : "Loading…")], "Merge");
    const status = mergeStatus(mr, t), s = mr.detailedMergeStatus;
    const canWait = this.settings.autoMergeAllowed && CAN_WAIT.has(s);
    const repoDeletes = this.settings.deleteBranchOnMerge;
    return this.frame(t, `Merge #${target.iid}`, [
      muted(mr.title),
      h_flex().gap(6).text_size(12).child(div().text_color(t.dim).child(`${mr.sourceBranch} → ${mr.targetBranch} · ${mr.commitCount} commit${mr.commitCount === 1 ? "" : "s"} ·`)).child(div().text_color(status.color).child(status.label)),
      div().h(2),
      this.settings.methods.length ? this.methods(t) : div().text_size(12).text_color(t.ansi1).child("This repository allows no merge method."),
      toggle("gh-remove", "Delete the branch", repoDeletes || (this.removeSource && !this.auto), t, {
        disabled: repoDeletes || mr.crossRepo || this.auto,
        hint: repoDeletes ? "on in this repository" : mr.crossRepo ? "a fork's branch" : this.auto ? "the repository decides" : null,
        onChange: (v, cx) => { this.removeSource = v; cx.notify(); },
      }),
      ...(canWait ? [toggle("gh-auto", "Merge when it's ready (auto-merge)", this.auto, t, { onChange: (v, cx) => { this.auto = v; cx.notify(); } })] : []),
      ...(!this.canConfirm() && !this.busy && this.method && !CAN_MERGE.has(s) && !(this.auto && CAN_WAIT.has(s))
        ? [div().text_size(12).text_color(t.ansi3).child(`Can't merge now: ${status.label.toLowerCase()}.`)]
        : []),
    ], this.auto ? "Enable auto-merge" : "Merge");
  }
}
