// Footer with subscription limits: Claude (5h and week) and Codex (its windows).
// limits.py fetches them; this mod polls both every 5 minutes, and one provider when
// its row is clicked. A failed poll keeps the last numbers and marks the provider.
import { View, div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { exec, theme, appHome, checking } from "herdr";

const EVERY = 5 * 60_000; // the Claude usage endpoint answers 429 when polled often
const TICK = 60_000; // redraw for the "resets in" countdowns
const BAR = 40;
const BAR_H = 6;
const PROVIDERS = [
  ["claude", "Claude"],
  ["codex", "Codex"],
];

function left(resets) {
  const minutes = Math.max(0, Math.round((resets - Date.now()) / 60_000));
  if (minutes < 60) return `${minutes}м`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}ч ${minutes % 60}м`;
  return `${Math.floor(hours / 24)}д ${hours % 24}ч`;
}

function clock(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export default class ProviderLimits extends View {
  init(_props, cx) {
    this.data = {};
    this.busy = new Set();
    this.at = {};
    if (checking()) return;
    this.refresh(cx);
    cx.timer.every(EVERY, (cx) => this.refresh(cx));
    cx.timer.every(TICK, (cx) => cx.notify());
  }

  // Polls the given providers (all by default); one already in flight is skipped.
  refresh(cx, ids = PROVIDERS.map(([id]) => id)) {
    const todo = ids.filter((id) => !this.busy.has(id));
    if (!todo.length) return;
    for (const id of todo) this.busy.add(id);
    cx.notify();
    cx.spawn(async (cx) => {
      let next = {};
      try {
        const r = await exec("python3", ["-I", `${appHome()}/mods/provider-limits/limits.py`, ...todo], { timeout: 45_000 });
        next = JSON.parse(r.stdout);
      } catch (e) {
        const error = `limits.py: ${e?.message ?? e}`;
        next = Object.fromEntries(todo.map((id) => [id, { error }]));
      }
      for (const id of todo) {
        const fresh = next[id] ?? { error: "нет данных" };
        this.data[id] = fresh.windows ? fresh : { windows: this.data[id]?.windows, error: fresh.error };
        if (fresh.windows) this.at[id] = Date.now();
        this.busy.delete(id);
      }
      cx.notify();
    });
  }

  meter(t, id, w) {
    const used = Math.min(100, Math.max(0, w.used));
    const color = used >= 90 ? t.blocked : used >= 70 ? t.ansi3 : t.done;
    const hint = w.resets ? `сброс в ${clock(w.resets)}, через ${left(w.resets)}` : "время сброса неизвестно";
    // A non-empty fill keeps at least a pixel, so 1% is still visible.
    const fill = used > 0 ? Math.max(1, Math.round((BAR * used) / 100)) : 0;
    return h_flex().id(`${id}-${w.label}`).flex_none().gap(6).items_center().tooltip(hint)
      .child(div().text_color(t.dim).child(w.label))
      .child(div().flex_none().w(BAR).h(BAR_H).bg(t.border).overflow_hidden()
        .child(div().h_full().w(fill).bg(color)))
      .child(div().flex_none().text_color(used >= 70 ? color : t.muted).child(`${Math.round(used)}%`))
      .when(Boolean(w.resets), (el) => el.child(div().flex_none().text_color(t.dim).child(left(w.resets))));
  }

  // The whole row is the provider's refresh button.
  provider(t, id, name) {
    const d = this.data[id];
    const busy = this.busy.has(id);
    const tip = [
      busy ? "обновляю…" : this.at[id] ? `обновлено в ${clock(this.at[id])}` : null,
      busy ? null : `Клик — обновить ${name}`,
    ].filter(Boolean).join("\n");
    const row = h_flex().id(`p-${id}`).flex_none().h_full().px(8).gap(12).items_center()
      .cursor_pointer().hover((s) => s.bg(t.hover)).tooltip(tip)
      .on_click((_e, cx) => this.refresh(cx, [id]))
      .when(busy, (el) => el.loop("opacity", { from: 0.4, to: 1, period: 900 }))
      .child(div().text_color(t.foreground).child(name));
    if (!d) return row.child(div().text_color(t.dim).child("…"));
    const windows = d.windows ?? [];
    return row
      .children(windows.map((w) => this.meter(t, id, w)))
      .when(Boolean(d.error), (el) => el.child(
        div().id(`err-${id}`).text_color(windows.length ? t.ansi3 : t.blocked)
          .tooltip(windows.length ? `не обновилось: ${d.error}` : d.error)
          .child(windows.length ? "⚠" : d.error)));
  }

  render(_cx) {
    const t = theme();
    const sep = () => div().flex_none().w(1).h(12).bg(t.border);
    const providers = PROVIDERS.flatMap(([id, name], i) => (i ? [sep(), this.provider(t, id, name)] : [this.provider(t, id, name)]));
    return h_flex().id("root").size_full().px(6).gap(8).items_center()
      .bg(t.chrome).border_t(1).border_color(t.border).text_size(12).line_height("16px").text_color(t.muted)
      .children(providers);
  }
}
