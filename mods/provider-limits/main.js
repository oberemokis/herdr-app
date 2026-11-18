// Footer with subscription limits: Claude (5h and week) and Codex (its windows).
// limits.py fetches both; this mod polls it every 5 minutes and on click.
// A failed poll keeps the last numbers and marks the provider with a warning.
import { View, div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { exec, theme, appHome, checking } from "herdr";

const EVERY = 5 * 60_000; // the Claude usage endpoint answers 429 when polled often
const TICK = 60_000; // redraw for the "resets in" countdowns
const BAR = 36;
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
    this.busy = false;
    this.at = null;
    if (checking()) return;
    this.refresh(cx);
    cx.timer.every(EVERY, (cx) => this.refresh(cx));
    cx.timer.every(TICK, (cx) => cx.notify());
  }

  refresh(cx) {
    if (this.busy) return;
    this.busy = true;
    cx.notify();
    cx.spawn(async (cx) => {
      let next = {};
      try {
        const r = await exec("python3", ["-I", `${appHome()}/mods/provider-limits/limits.py`], { timeout: 45_000 });
        next = JSON.parse(r.stdout);
        this.at = Date.now();
      } catch (e) {
        const error = `limits.py: ${e?.message ?? e}`;
        next = Object.fromEntries(PROVIDERS.map(([id]) => [id, { error }]));
      }
      for (const [id] of PROVIDERS) {
        const fresh = next[id] ?? { error: "нет данных" };
        this.data[id] = fresh.windows ? fresh : { windows: this.data[id]?.windows, error: fresh.error };
      }
      this.busy = false;
      cx.notify();
    });
  }

  meter(t, id, w) {
    const used = Math.min(100, Math.max(0, w.used));
    const color = used >= 90 ? t.blocked : used >= 70 ? t.ansi3 : t.done;
    const hint = w.resets ? `сброс в ${clock(w.resets)}, через ${left(w.resets)}` : "время сброса неизвестно";
    return h_flex().id(`${id}-${w.label}`).gap(5).items_center().tooltip(hint)
      .child(div().text_color(t.dim).child(w.label))
      .child(div().w(BAR).h(4).rounded(2).bg(t.border)
        .child(div().h_full().w((BAR * used) / 100).rounded(2).bg(color)))
      .child(div().text_color(used >= 70 ? color : t.muted).child(`${Math.round(used)}%`))
      .when(Boolean(w.resets), (el) => el.child(div().text_color(t.dim).child(left(w.resets))));
  }

  provider(t, id, name) {
    const d = this.data[id];
    const row = h_flex().id(`p-${id}`).gap(10).items_center()
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
    const status = this.busy ? "обновляю…" : this.at ? `обновлено ${clock(this.at)}` : "";
    return h_flex().id("root").size_full().px(14).gap(22).items_center()
      .bg(t.chrome).border_t(1).border_color(t.border).text_size(11.8).text_color(t.muted)
      .children(PROVIDERS.map(([id, name]) => this.provider(t, id, name)))
      .child(div().flex_1())
      .child(div().id("refresh").text_color(t.dim).hover((s) => s.text_color(t.foreground))
        .tooltip("Обновить лимиты").on_click((_e, cx) => this.refresh(cx)).child(status));
  }
}
