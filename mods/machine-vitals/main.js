// This Mac at a glance: CPU over the last two minutes, memory as Activity Monitor
// counts it (colored by memory pressure), disk and battery. One cheap shell call
// per sample; click opens the monitor window (monitor.js), the same mod with props.monitor.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, theme, layout, window, props, openOverlay, checking } from "herdr";
import { squareCorners } from "./square.js";
import { PROCS, parseProcs, gb } from "./stats.js";
import { store, sample } from "./history.js";
import { Monitor } from "./monitor.js";

const SAMPLES = 40; // CPU history: 40 samples, 2 minutes while the window is in front
const EVERY = 3000; // ms between samples while the window is in front
const AWAY = 30000; // ms between samples while it is behind
function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

export default class MachineVitals extends View {
  init(given, cx) {
    squareCorners();
    const p = { ...(given ?? {}), ...(props() ?? {}) };
    if (p.monitor) {
      this.monitor = new Monitor(p, cx);
      return;
    }
    this.procs = [];
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

  loadProcs(cx) {
    cx.spawn(async (cx) => {
      try { this.procs = parseProcs((await exec("sh", ["-c", PROCS])).stdout); } catch { this.procs = []; }
      cx.notify();
    });
  }

  render(cx) {
    if (this.monitor) return this.monitor.render(cx);
    const t = theme();
    const s = store.now;
    const cpus = store.samples.slice(-SAMPLES).map((x) => x.cpu).filter((x) => x !== null);
    const cpu = cpus.at(-1) ?? null;
    const warn = (pct, high = 85) => (pct >= 95 ? t.ansi1 : pct >= high ? t.ansi3 : t.accent);
    const memColor = !s ? t.accent : s.mem.pressure >= 4 ? t.ansi1 : s.mem.pressure >= 2 ? t.ansi3 : t.accent;
    const memPct = s?.mem.total ? (s.mem.used / s.mem.total) * 100 : 0;
    const diskUsed = s?.disk ? 100 - (s.disk.free / s.disk.total) * 100 : 0;
    const pressureName = { 1: "normal", 2: "warning", 4: "critical" }[s?.mem.pressure] ?? "unknown";

    const root = v_flex()
      .id("machine-vitals")
      .size_full()
      .bg(t.chrome)
      .text_size(12)
      .cursor_pointer()
      .tooltip("Открыть монитор")
      .on_click(() => this.open());

    if (narrow()) {
      const mini = (label, pct, color) =>
        v_flex().items_center().child(div().text_size(9).text_color(t.dim).child(label))
          .child(div().text_size(11).text_color(color).child(pct === null ? "–" : `${Math.round(pct)}%`));
      return root.items_center().justify_center().gap(6)
        .child(mini("CPU", cpu, cpu === null ? t.dim : warn(cpu)))
        .child(mini("MEM", s ? memPct : null, memColor));
    }

    const bar = (pct, color) =>
      div().flex_1().h(6).rounded(3).bg(t.border).overflow_hidden()
        .child(div().h_full().w(`${Math.max(0, Math.min(100, pct))}%`).rounded(3).bg(color));
    const row = (id, label, viz, value, valueColor, tip, onHover) =>
      h_flex().id(id).h(20).gap(8).items_center()
        .child(div().w(30).flex_none().text_size(11).text_color(t.dim).child(label))
        .child(viz)
        .child(div().w(72).flex_none().text_right().text_size(11.5).text_color(valueColor ?? t.foreground).truncate().child(value))
        .when(Boolean(tip), (el) => el.tooltip(tip))
        .when(Boolean(onHover), (el) => el.on_hover(onHover));

    const spark = h_flex().flex_1().h(18).items_end().gap(1).children(
      Array.from({ length: SAMPLES }, (_, i) => {
        const v = cpus[i - (SAMPLES - cpus.length)];
        return div().flex_1().min_w(1).rounded(1)
          .h(v === undefined ? 1 : Math.max(1, Math.round((v / 100) * 18)))
          .bg(v === undefined ? t.border : i === SAMPLES - 1 ? warn(v) : warn(v) + "99");
      }),
    );

    const b = s?.battery;
    const header = h_flex().px(16).h(30).pt(8).flex_none().items_center().justify_between()
      .child(div().text_size(11.5).font_medium().text_color(t.dim).child("This Mac"))
      .when(Boolean(b), (el) => el.child(
        h_flex().id("mv-battery").gap(4).items_center().text_size(11).text_color(b.pct <= 15 && !b.ac ? t.ansi1 : t.dim)
          .when(b.ac, (el) => el.child(svg("mods/machine-vitals/plug.svg").size(12)))
          .child(`Battery ${b.pct}%`)
          .tooltip(`Battery ${b.pct}%, ${b.state}${b.ac ? ", on AC power" : ""}`)));

    const procs = this.procs.map((p) => `${p.name}  ${Math.round(p.cpu)}%`).join("\n");
    return root
      .child(header)
      .child(
        v_flex().px(16).pb(6).gap(1)
          .when(Boolean(store.error) && !s, (el) => el.child(div().text_size(11).text_color(t.ansi1).truncate().child(store.error ?? "")))
          .child(row("mv-cpu", "CPU", spark, cpu === null ? "…" : `${Math.round(cpu)}%`, cpu === null ? t.dim : warn(cpu) === t.accent ? null : warn(cpu),
            procs ? `Most CPU lately:\n${procs}` : "Most CPU lately: …", (hovered, cx) => { if (hovered) this.loadProcs(cx); }))
          .child(row("mv-mem", "Mem", bar(memPct, memColor), s ? `${gb(s.mem.used)}/${gb(s.mem.total)} GB` : "…", memColor === t.accent ? null : memColor,
            s ? `Memory pressure ${pressureName}${s.swap ? `, swap used ${gb(s.swap)} GB` : ", no swap"}` : null))
          .child(row("mv-disk", "Disk", bar(diskUsed, warn(diskUsed, 90)), s?.disk ? `${gb(s.disk.free)} GB free` : "…", diskUsed >= 90 ? warn(diskUsed, 90) : null, null)),
      );
  }
}
