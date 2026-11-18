// The window the sidebar panel opens: the machine over the last hour (from the panel's own
// samples, history.js), disk,
// and Herdr's own processes: the app, herdr-core, and whatever runs in its terminals.
import { div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { exec, theme, closeOverlay } from "herdr";
import { store, sample, HOUR } from "./history.js";
import { TREE, HOST, parseTree, parseHost, GROUPS, bytes, rate } from "./stats.js";

const EVERY = 3000;
const BINS = 60;
const RANGES = [["5m", 5 * 60_000, "5 мин"], ["15m", 15 * 60_000, "15 мин"], ["1h", HOUR, "1 ч"]];
const FILTERS = [["all", "Все"], ["herdr", "Herdr"], ["agents", "Агенты"], ["terminals", "Терминалы"]];
const KIND = { herdr: "Herdr", agent: "агент", tool: "от агента", shell: "терминал" };
const ROWS = 300;
const PX = 20;
const ICON = "mods/machine-vitals";

const pct1 = (v) => `${(Math.round(v * 10) / 10).toFixed(1)}%`;

function since(ms) {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 60) return `${minutes} мин`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ч ${minutes % 60} мин`;
  return `${Math.floor(hours / 24)} д ${hours % 24} ч`;
}

// Samples → BINS averages over the last `span` ms. A bin without a sample repeats the one
// before it (the panel samples every 30 s while Herdr is behind), bins before the first are null.
function bins(samples, span, pick) {
  const end = Date.now();
  const start = end - span;
  const sum = Array(BINS).fill(0);
  const count = Array(BINS).fill(0);
  for (const s of samples) {
    const v = pick(s);
    if (s.t < start || v === null || v === undefined) continue;
    const i = Math.min(BINS - 1, Math.floor(((s.t - start) / span) * BINS));
    sum[i] += v;
    count[i]++;
  }
  let last = null;
  return sum.map((v, i) => (last = count[i] ? v / count[i] : last));
}

export class Monitor {
  constructor(props, cx) {
    this.overlay = props?.overlay;
    this.range = "15m";
    this.filter = "all";
    this.sort = "cpu";
    this.q = "";
    this.paused = null; // { now, samples, procs } while paused
    this.procs = [];
    this.procsAt = 0;
    this.host = null;
    this.input = InputState.new({ placeholder: "Имя или PID" });
    this.input.on("change", (_e, cx) => { this.q = this.input.value().trim().toLowerCase(); cx.notify(); });
    cx.spawn(async (cx) => {
      try { this.host = parseHost((await exec("sh", ["-c", HOST])).stdout); } catch { this.host = null; }
      cx.notify();
    });
    this.tick(cx);
    cx.timer.every(EVERY, (cx) => this.tick(cx));
  }

  tick(cx) {
    if (this.paused) return;
    cx.spawn(async (cx) => {
      await sample(EVERY);
      try {
        const r = await exec("sh", ["-c", TREE]);
        this.procs = parseTree(r.stdout);
        this.procsAt = Date.now();
        this.procsError = null;
      } catch (e) {
        this.procsError = String(e);
      }
      cx.notify();
    });
  }

  view() {
    return this.paused ?? { now: store.now, samples: store.samples, procs: this.procs };
  }

  // A square control with an icon, as the pane header's buttons.
  icon(t, id, path, tip, onClick) {
    return h_flex().id(id).size(26).flex_none().items_center().justify_center().cursor_pointer()
      .text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground))
      .tooltip(tip).on_click(onClick)
      .child(svg(path).size(14));
  }

  // Segmented choice in one frame: [[id, label]], the picked one raised.
  segments(t, name, items, picked, pick) {
    return h_flex().flex_none().h(24).border_1().border_color(t.border).children(items.map(([id, label], i) =>
      div().id(`${name}-${id}`).h_full().px(10).flex().items_center().cursor_pointer().text_size(11.5)
        .when(i > 0, (el) => el.border_l(1).border_color(t.border))
        .when(id === picked, (el) => el.bg(t.raised).text_color(t.foreground))
        .when(id !== picked, (el) => el.text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground)))
        .on_click((_e, cx) => { pick(id); cx.notify(); })
        .child(label)));
  }

  // A section's header strip, as a pane's: the title, a note, controls on the right.
  strip(t, title, note, right) {
    return h_flex().flex_none().h(36).px(PX).gap(8).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .child(div().text_size(12).font_medium().text_color(t.foreground).child(title))
      .when(Boolean(note), (el) => el.child(div().text_size(11.5).text_color(t.dim).truncate().child(note ?? "")))
      .child(div().flex_1())
      .when(Boolean(right), (el) => el.child(right));
  }

  header(t) {
    const h = this.host;
    const sub = [h?.host, h?.boot ? `работает ${since(Date.now() - h.boot)}` : null].filter(Boolean).join(" · ");
    const live = !this.paused;
    return h_flex().flex_none().h(44).pl(PX).pr(10).gap(10).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .child(div().text_size(13).font_semibold().text_color(t.foreground).child("Монитор"))
      .child(div().flex_1().min_w(0).text_size(12).text_color(t.dim).truncate().child(sub || "…"))
      .child(h_flex().flex_none().h(24).px(10).gap(6).items_center().border_1().border_color(t.border).text_size(11.5).text_color(live ? t.muted : t.dim)
        .child(div().size(6).rounded_full().bg(live ? t.done : t.dim).when(live, (el) => el.loop("opacity", { from: 0.35, to: 1, period: 1600 })))
        .child(live ? "В реальном времени" : "Пауза"))
      .child(this.icon(t, "mon-pause", `${ICON}/${live ? "pause" : "play"}.svg`, live ? "Остановить обновление" : "Продолжить",
        (_e, cx) => {
          this.paused = live ? { now: store.now, samples: [...store.samples], procs: this.procs } : null;
          if (!this.paused) this.tick(cx);
          cx.notify();
        }))
      .child(this.icon(t, "mon-close", "mods/workspace-chrome/x.svg", "Закрыть (Esc)", () => closeOverlay(this.overlay)));
  }

  // One cell of the machine row: a label, the value, a line under it, and a chart.
  stat(t, { id, label, value, color, under, values, max, chart, last }) {
    const H = 52;
    const bars = h_flex().id(`${id}-chart`).h(H).w_full().items_end().gap(1).border_b(1).border_color(t.border)
      .children(values.map((v) => v === null
        ? div().flex_1().min_w(1).h(0)
        : div().flex_1().min_w(1).h(Math.max(1, Math.round((Math.min(v, max) / (max || 1)) * H))).bg(chart + "b3")));
    return v_flex().flex_1().min_w(0).px(PX).pt(18).pb(20).gap(4)
      .when(!last, (el) => el.border_r(1).border_color(t.border))
      .child(div().text_size(11.5).text_color(t.dim).child(label))
      .child(div().text_size(26).line_height("34px").font_medium().text_color(color ?? t.foreground).truncate().child(value))
      .child(div().text_size(11.5).text_color(t.dim).truncate().child(under))
      .child(div().pt(16).child(bars));
  }

  machine(t, v) {
    const s = v.now;
    const span = RANGES.find(([id]) => id === this.range)[1];
    const warn = (pct, high = 85) => (pct >= 95 ? t.ansi1 : pct >= high ? t.ansi3 : null);
    const memColor = !s ? null : s.mem.pressure >= 4 ? t.ansi1 : s.mem.pressure >= 2 ? t.ansi3 : null;
    const pressure = { 1: "давление в норме", 2: "давление повышено", 4: "давление критическое" }[s?.mem.pressure] ?? "";
    const net = bins(v.samples, span, (x) => (x.rx === null ? null : x.rx + x.tx));
    const covered = v.samples.length ? Date.now() - v.samples[0].t : 0;
    const cpu = s?.cpu ?? null;
    return v_flex().flex_none().border_b(1).border_color(t.border)
      .child(this.strip(t, "Машина", covered ? `история ${since(covered)}` : "история копится",
        this.segments(t, "range", RANGES.map(([id, , label]) => [id, label]), this.range, (id) => { this.range = id; })))
      .child(h_flex().items_stretch()
        .child(this.stat(t, {
          id: "mon-cpu", label: "CPU",
          value: cpu === null ? "…" : `${Math.round(cpu)}%`, color: cpu === null ? t.dim : warn(cpu),
          under: s ? `${s.cores} ядер${s.load !== null ? ` · нагрузка ${s.load.toFixed(2)}` : ""}` : "…",
          values: bins(v.samples, span, (x) => x.cpu), max: 100, chart: (cpu !== null && warn(cpu)) || t.accent,
        }))
        .child(this.stat(t, {
          id: "mon-mem", label: "Память",
          value: s ? bytes(s.mem.used) : "…", color: memColor,
          under: s ? `${Math.round((s.mem.used / (s.mem.total || 1)) * 100)}% из ${bytes(s.mem.total)} · ${pressure}${s.swap ? ` · своп ${bytes(s.swap)}` : ""}` : "…",
          values: bins(v.samples, span, (x) => x.mem), max: s?.mem.total || 1, chart: memColor ?? t.ansi3,
        }))
        .child(this.stat(t, {
          id: "mon-net", label: "Сеть", last: true,
          value: s?.rx === null || !s ? "…" : `↓ ${rate(s.rx)}`,
          under: s?.tx === null || !s ? "считаю скорость…" : `↑ ${rate(s.tx)}`,
          values: net, max: Math.max(1, ...net.filter((x) => x !== null)), chart: t.ansi6,
        })))
      .child(this.disk(t, s));
  }

  disk(t, s) {
    const d = s?.disk;
    const used = d ? 100 - (d.free / d.total) * 100 : 0;
    const color = used >= 95 ? t.ansi1 : used >= 90 ? t.ansi3 : t.muted;
    return h_flex().flex_none().h(44).px(PX).gap(16).items_center().border_t(1).border_color(t.border)
      .child(div().w(72).flex_none().text_size(11.5).text_color(t.dim).child("Диск"))
      .child(div().flex_1().h(6).bg(t.border)
        .child(div().h_full().w(`${Math.max(0, Math.min(100, used))}%`).bg(color)))
      .child(div().flex_none().text_size(12).text_color(used >= 90 ? color : t.muted)
        .child(d ? `${bytes(d.free)} свободно из ${bytes(d.total)}` : "…"));
  }

  usage(t, v, cores) {
    const sum = (group) => v.procs.filter((p) => group === "all" || GROUPS[p.kind] === group)
      .reduce((a, p) => ({ cpu: a.cpu + p.cpu / cores, mem: a.mem + p.mem, n: a.n + 1 }), { cpu: 0, mem: 0, n: 0 });
    const cells = (el, label, n, cpu, mem) => el.h(32).px(PX).gap(16).items_center()
      .child(div().flex_1().min_w(0).truncate().child(label))
      .child(div().w(64).flex_none().text_right().child(n))
      .child(div().w(56).flex_none().text_right().child(cpu))
      .child(div().w(72).flex_none().text_right().child(mem));
    const line = (group, label, total) => {
      const x = sum(group);
      return cells(h_flex().text_size(12).text_color(total ? t.foreground : t.muted)
        .when(Boolean(total), (el) => el.font_medium().border_t(1).border_color(t.border)), label, String(x.n), pct1(x.cpu), bytes(x.mem));
    };
    return v_flex().flex_none().border_b(1).border_color(t.border)
      .child(this.strip(t, "Нагрузка Herdr"))
      .child(cells(h_flex().text_size(11).text_color(t.dim).border_b(1).border_color(t.border), "Группа", "процессов", "CPU", "память"))
      .child(v_flex().py(6)
        .child(line("herdr", "Herdr"))
        .child(line("agents", "Агенты и их инструменты"))
        .child(line("terminals", "Терминалы")))
      .child(line("all", "Всего", true));
  }

  table(t, v, cores) {
    const q = this.q;
    const counts = Object.fromEntries(FILTERS.map(([id]) => [id, v.procs.filter((p) => id === "all" || GROUPS[p.kind] === id).length]));
    const rows = v.procs
      .filter((p) => this.filter === "all" || GROUPS[p.kind] === this.filter)
      .filter((p) => !q || p.name.toLowerCase().includes(q) || String(p.pid).startsWith(q))
      .sort((a, b) => (this.sort === "cpu" ? b.cpu - a.cpu || b.mem - a.mem : b.mem - a.mem));
    const dot = { herdr: t.accent, agent: t.done, tool: t.muted, shell: t.dim };
    const cols = (el, kind, name, what, pid, cpu, mem) => el.px(PX).gap(16).items_center()
      .child(div().size(6).rounded_full().flex_none().when(Boolean(kind), (d) => d.bg(kind)))
      .child(name)
      .child(div().w(84).flex_none().child(what))
      .child(div().w(64).flex_none().text_right().child(pid))
      .child(div().w(64).flex_none().text_right().child(cpu))
      .child(div().w(80).flex_none().text_right().child(mem));
    const head = cols(h_flex().flex_none().h(30).text_size(11).text_color(t.dim).border_b(1).border_color(t.border),
      null, div().flex_1().min_w(0).child("Имя"), "Вид", "PID", "CPU", "Память");
    const row = (p) => cols(
      h_flex().id(`proc-${p.pid}`).h(30).text_size(12).border_b(1).border_color(t.border + "66").hover((s) => s.bg(t.hover)),
      dot[p.kind],
      div().flex_1().min_w(0).truncate().text_color(p.kind === "shell" ? t.muted : t.foreground).child(p.name),
      div().text_color(t.dim).text_size(11.5).child(KIND[p.kind]),
      div().text_color(t.dim).child(String(p.pid)),
      div().text_color(p.cpu / cores >= 10 ? t.ansi3 : t.muted).child(pct1(p.cpu / cores)),
      div().text_color(t.muted).child(bytes(p.mem)));
    const note = (text, color) => div().px(PX).py(14).text_size(12).text_color(color).child(text);

    return v_flex().flex_1().min_h(0)
      .child(this.strip(t, "Процессы", `${v.procs.length} в Herdr`,
        this.segments(t, "sort", [["cpu", "CPU"], ["mem", "Память"]], this.sort, (id) => { this.sort = id; })))
      .child(h_flex().flex_none().h(48).px(PX).gap(12).items_center().border_b(1).border_color(t.border)
        .child(this.segments(t, "filter", FILTERS.map(([id, label]) => [id, `${label} ${counts[id]}`]), this.filter, (id) => { this.filter = id; }))
        .child(h_flex().flex_1().min_w(0).h(28).px(10).gap(8).items_center().border_1().border_color(t.input).bg(t.background)
          .child(svg("mods/workspace-chrome/search.svg").size(13).flex_none().text_color(t.dim))
          .child(Input.new(this.input).flex_1().h_full().text_size(12).text_color(t.foreground))))
      .child(head)
      .child(v_flex().id("mon-procs").flex_1().min_h(0).overflow_y_scrollbar()
        .when(Boolean(this.procsError) && !v.procs.length, (el) => el.child(note(this.procsError ?? "", t.ansi1)))
        .when(!this.procsError && !this.procsAt, (el) => el.child(note("Читаю процессы…", t.dim)))
        .when(Boolean(this.procsAt) && !rows.length, (el) => el.child(note("Ничего не нашлось", t.dim)))
        .children(rows.slice(0, ROWS).map(row)));
  }

  footer(t, cores) {
    return h_flex().flex_none().h(32).px(PX).gap(12).items_center().justify_between()
      .bg(t.chrome).border_t(1).border_color(t.border).text_size(11.5).text_color(t.dim)
      .child(div().truncate().child(`CPU процесса — доля всей машины (${cores} ядер); только процессы Herdr`))
      .child(h_flex().flex_none().gap(16).items_center()
        .child(div().child(this.paused ? "обновление остановлено" : `обновляется каждые ${EVERY / 1000} с`))
        .child(h_flex().id("mon-activity").gap(5).items_center().cursor_pointer().hover((s) => s.text_color(t.foreground))
          .on_click(() => exec("open", ["-a", "Activity Monitor"]).catch(() => {}))
          .child("Activity Monitor").child(svg(`${ICON}/external.svg`).size(11))));
  }

  render(_cx) {
    const t = theme();
    const v = this.view();
    const cores = v.now?.cores ?? 1;
    return v_flex().id("monitor").size_full().min_h(0).bg(t.background).border_1().border_color(t.border)
      .text_color(t.foreground).text_size(12)
      .child(this.header(t))
      .child(this.machine(t, v))
      .child(this.usage(t, v, cores))
      .child(this.table(t, v, cores))
      .child(this.footer(t, cores));
  }
}
