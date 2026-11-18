// This Mac in one line on the right of the footer under the terminals: CPU with a spark,
// memory (colored by pressure); the rest in the tooltip. One cheap shell call per sample;
// click opens the monitor window (monitor.js), the same mod with props.monitor.
import { View, div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { theme, window, props, openOverlay, checking } from "herdr";
import { squareCorners } from "./square.js";
import { gb } from "./stats.js";
import { store, sample } from "./history.js";
import { Monitor } from "./monitor.js";

const SAMPLES = 40; // CPU history kept for the spark: 2 minutes while the window is in front
const SPARK = 16; // bars in the compact panel's spark
const EVERY = 3000; // ms between samples while the window is in front
const AWAY = 30000; // ms between samples while it is behind

export default class MachineVitals extends View {
  init(given, cx) {
    squareCorners();
    const p = { ...(given ?? {}), ...(props() ?? {}) };
    if (p.monitor) {
      this.monitor = new Monitor(p, cx);
      return;
    }
    if (checking()) return;
    this.sample(cx, 0);
    cx.timer.every(EVERY, (cx) => this.sample(cx, window().active ? EVERY : AWAY));
  }

  // The history is shared with the monitor window: whichever asks first samples.
  sample(cx, every) {
    cx.spawn(async (cx) => { if (await sample(every)) cx.notify(); });
  }

  open() {
    openOverlay({ mod: "machine-vitals", props: { monitor: true }, kind: "dialog", frame: "none", width: 880, height: 0.9 });
  }

  render(cx) {
    if (this.monitor) return this.monitor.render(cx);
    const t = theme();
    const s = store.now;
    const cpus = store.samples.slice(-SAMPLES).map((x) => x.cpu).filter((x) => x !== null);
    const cpu = cpus.at(-1) ?? null;
    const warn = (pct, high = 85) => (pct >= 95 ? t.ansi1 : pct >= high ? t.ansi3 : null);
    const memColor = !s ? null : s.mem.pressure >= 4 ? t.ansi1 : s.mem.pressure >= 2 ? t.ansi3 : null;
    const memPct = s?.mem.total ? (s.mem.used / s.mem.total) * 100 : null;
    const pct = (v) => (v === null ? "…" : `${Math.round(v)}%`);

    // Everything the old tall panel showed, for the tooltip.
    const b = s?.battery;
    const pressure = { 1: "в норме", 2: "повышено", 4: "критическое" }[s?.mem.pressure] ?? "неизвестно";
    const tip = !s ? (store.error ?? "Собираю данные…") : [
      `CPU ${pct(cpu)} · ${s.cores} ядер${s.load !== null ? ` · нагрузка ${s.load.toFixed(2)}` : ""}`,
      `Память ${gb(s.mem.used)} из ${gb(s.mem.total)} ГБ · давление ${pressure}${s.swap ? ` · своп ${gb(s.swap)} ГБ` : ""}`,
      s.disk ? `Диск: свободно ${gb(s.disk.free)} из ${gb(s.disk.total)} ГБ` : null,
      b ? `Батарея ${b.pct}%, ${b.state}${b.ac ? ", от сети" : ""}` : null,
      "",
      "Клик — открыть монитор",
    ].filter((x) => x !== null).join("\n");

    const value = (v, color) => div().flex_none().text_color(color ?? t.foreground).child(pct(v));
    const label = (text) => div().flex_none().text_color(t.dim).child(text);
    const sep = () => div().flex_none().w(1).h(12).bg(t.border);

    const spark = h_flex().flex_none().w(SPARK * 3 - 1).h(12).items_end().gap(1).children(
      Array.from({ length: SPARK }, (_, i) => {
        const v = cpus.slice(-SPARK)[i - (SPARK - Math.min(SPARK, cpus.length))];
        return div().w(2).flex_none()
          .h(v === undefined ? 1 : Math.max(1, Math.round((v / 100) * 12)))
          .bg(v === undefined ? t.border : (warn(v) ?? t.accent) + (i === SPARK - 1 ? "" : "99"));
      }));
    const bar = h_flex().flex_none().w(32).h(6).bg(t.border)
      .child(div().h_full().w(`${Math.max(0, Math.min(100, memPct ?? 0))}%`).bg(memColor ?? t.accent));

    // The block is wider than its content: the content sits on the right, and only it
    // reacts to the pointer, like the provider rows on the left of the footer.
    return h_flex().id("machine-vitals").size_full().px(6).items_center().justify_end()
      .bg(t.chrome).border_t(1).border_color(t.border).text_size(12).line_height("16px")
      .child(h_flex().id("mv-open").flex_none().h_full().px(8).gap(8).items_center().cursor_pointer()
        .hover((st) => st.bg(t.hover)).tooltip(tip).on_click(() => this.open())
        .when(Boolean(b) && (b.pct <= 20 || !b.ac), (el) => el
          .child(div().flex_none().text_color(b.pct <= 15 && !b.ac ? t.ansi1 : t.dim).child(`⚡${b.pct}%`))
          .child(sep().mx(4)))
        .child(label("CPU")).child(spark).child(value(cpu, cpu === null ? t.dim : warn(cpu)))
        .child(sep().mx(4))
        .child(label("RAM")).child(bar).child(value(memPct, memColor)));
  }
}
