// Ports: who listens on which TCP port, grouped by the git worktree it was started from.
// Made for many worktrees at once: a dev server left running in one of them holds the
// port the next one needs. Shows the conflict, the nearest free port, and stops the
// holder (a process with SIGTERM, then SIGKILL if it stays; a container with docker stop).
// Scans with scan.sh every few seconds, only while the panel is on screen.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { exec, theme, layout, window, spaces, focused, panes, settings, appHome, checking } from "herdr";
import { squareCorners } from "./square.js";
import { parse, isDev, freeFrom, age, base } from "./scan.js";

const EVERY = 4000; // ms between scans while the panel is shown and the window is in front
const STUCK = 15_000; // a scan older than this is considered lost, the next one may start
const STAY = 2500; // ms after SIGTERM before offering SIGKILL
const ICONS = "mods/ports/icons";
const VM = /^(OrbStack|com\.docker|vpnkit|docker|limactl|gvproxy)/i;

function pathTo(node, id) {
  if (!node) return null;
  if (node.id === id) return [node];
  for (const child of node.children ?? []) {
    const path = pathTo(child, id);
    if (path) return [node, ...path];
  }
  return null;
}

// Shown unless something on the way down to the block is hidden, or a stack on the way
// shows another child. A block outside the layout counts as shown.
function shown(id) {
  const path = pathTo(layout(), id);
  if (!path) return true;
  return path.every((n, i) => !n.hidden
    && (n.type !== "stack" || i === path.length - 1 || (n.active ?? n.children?.[0]?.id) === path[i + 1].id));
}

// The folder of the focused pane: its worktree goes first.
function here() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  return pane?.cwd || f?.cwd || space?.folder || null;
}

const keyOf = (r) => `${r.pid}:${r.port}`;
const inside = (dir, top) => Boolean(dir) && (dir === top || dir.startsWith(top + "/"));
const tilde = (path, home) => (home && path.startsWith(home) ? "~" + path.slice(home.length) : path);

// What a row belongs to: a worktree, a compose folder, a plain folder, or the system.
function groupOf(r, home) {
  if (!isDev(r)) return { key: "system", title: "Система и приложения", order: 3 };
  const g = r.git;
  if (g) return { key: g.top, title: g.worktree ? `${g.repo} › ${g.worktree}` : g.repo, branch: g.branch, top: g.top, order: 1 };
  const c = r.container;
  if (c?.dir && c.dir !== "/") {
    const wt = c.dir.match(/^(.*)\/\.worktrees\/([^/]+)/);
    return {
      key: c.dir, order: 1, gone: c.gone, top: c.dir,
      title: wt ? `${base(wt[1])} › ${wt[2]}` : c.project ?? base(c.dir),
    };
  }
  if (c) return { key: `docker:${c.project ?? ""}`, title: c.project ? `Docker · ${c.project}` : "Docker", order: 2 };
  const dir = r.cwd && r.cwd !== "/" ? r.cwd : null;
  return { key: `dir:${dir ?? ""}`, title: dir ? tilde(dir, home) : "Без папки", order: 2 };
}

export default class Ports extends View {
  init(_props, cx) {
    squareCorners();
    this.rows = [];
    this.home = null;
    this.at = 0;
    this.busy = 0;
    this.error = null;
    this.mode = "dev";
    this.q = "";
    this.hovered = null;
    this.confirm = null; // the row key whose stop button asks to be clicked again
    this.stopping = new Map(); // row key -> { at, how: "term" | "kill" | "docker", error? }
    this.copied = null;
    this.input = InputState.new({ placeholder: "Порт, процесс или папка" });
    this.input.on("change", (_e, cx) => { this.q = this.input.value().trim().toLowerCase(); cx.notify(); });
    if (checking()) return;
    this.tick(cx);
    cx.timer.every(1000, (cx) => this.tick(cx));
  }

  tick(cx) {
    if (!shown("ports") || !window().active) return;
    if (Date.now() - this.at >= EVERY) this.scan(cx);
  }

  scan(cx) {
    const started = Date.now();
    if (this.busy && started - this.busy < STUCK) return;
    this.busy = started;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const r = await exec("sh", [`${appHome()}/mods/ports/scan.sh`], { timeout: STUCK - 3000 });
        this.rows = parse(r.stdout);
        this.home = r.stdout.match(/^@home\n(.*)$/m)?.[1] ?? null;
        this.error = null;
        // A stop that worked: the row is gone. One that didn't: offer SIGKILL.
        const alive = new Set(this.rows.map(keyOf));
        for (const key of [...this.stopping.keys()]) if (!alive.has(key)) this.stopping.delete(key);
      } catch (e) {
        this.error = `scan.sh: ${e?.message ?? e}`;
      } finally {
        if (this.busy === started) this.busy = 0;
        this.at = Date.now();
        cx.notify();
      }
    });
  }

  // Herdr itself and the Docker VM's process are not ours to stop.
  stoppable(r) {
    if (r.origin === "self") return false;
    if (VM.test(r.name ?? "")) return Boolean(r.container);
    return true;
  }

  stop(cx, r, force) {
    const key = keyOf(r);
    this.confirm = null;
    const how = r.container ? "docker" : force ? "kill" : "term";
    this.stopping.set(key, { at: Date.now(), how });
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const res = how === "docker"
          ? await exec("docker", ["stop", r.container.name], { timeout: 60_000 })
          : await exec("kill", [force ? "-KILL" : "-TERM", String(r.pid)]);
        if (res.code !== 0) this.stopping.set(key, { at: Date.now(), how, error: res.stderr.trim() || `код ${res.code}` });
      } catch (e) {
        this.stopping.set(key, { at: Date.now(), how, error: String(e?.message ?? e) });
      }
      this.scan(cx);
      cx.timer.after(STAY + 100, (cx) => this.scan(cx));
    });
  }

  copy(cx, key, text) {
    cx.write_to_clipboard(text);
    this.copied = key;
    cx.notify();
    cx.timer.after(1500, (cx) => { if (this.copied === key) { this.copied = null; cx.notify(); } });
  }

  // ---- drawing

  button(t, id, icon, tip, onClick, color) {
    return h_flex().id(id).size(24).flex_none().items_center().justify_center().cursor_pointer()
      .text_color(color ?? t.dim).hover((s) => s.bg(t.hover).text_color(color ?? t.foreground))
      .tooltip(tip).on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); })
      .child(svg(`${ICONS}/${icon}.svg`).size(14));
  }

  segments(t, items, picked, pick) {
    return h_flex().flex_none().h(22).border_1().border_color(t.border).children(items.map(([id, label], i) =>
      div().id(`mode-${id}`).h_full().px(8).flex().items_center().cursor_pointer().text_size(11.5)
        .when(i > 0, (el) => el.border_l(1).border_color(t.border))
        .when(id === picked, (el) => el.bg(t.raised).text_color(t.foreground))
        .when(id !== picked, (el) => el.text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground)))
        .on_click((_e, cx) => { pick(id); cx.notify(); })
        .child(label)));
  }

  header(t, dev) {
    return h_flex().h(32).flex_none().pl(14).pr(6).gap(8).items_center().border_b(1).border_color(t.border)
      .child(div().text_size(12).font_medium().child("Порты"))
      .child(div().flex_1())
      .child(this.segments(t, [["dev", `Разработка ${dev}`], ["all", `Все ${this.rows.length}`]], this.mode, (id) => { this.mode = id; }))
      .child(h_flex().id("ports-refresh").size(24).flex_none().items_center().justify_center().cursor_pointer()
        .text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground))
        .tooltip("Обновить").on_click((_e, cx) => this.scan(cx))
        .child(svg(`${ICONS}/refresh.svg`).size(14).when(Boolean(this.busy), (el) => el.spin(900))));
  }

  search(t) {
    return h_flex().flex_none().h(40).px(10).items_center().border_b(1).border_color(t.border)
      .child(h_flex().flex_1().h(28).px(8).gap(8).items_center().border_1().border_color(t.input).bg(t.background)
        .child(svg(`${ICONS}/search.svg`).size(13).flex_none().text_color(t.dim))
        .child(Input.new(this.input).flex_1().h_full().text_size(12.5).text_color(t.foreground)));
  }

  // A number in the search answers "is this port free?" before anything else.
  answer(t, mono) {
    if (!/^\d{1,5}$/.test(this.q) || !this.at) return null;
    const port = Number(this.q);
    if (port < 1 || port > 65535) return null;
    const busy = this.rows.some((r) => r.port === port);
    const free = busy ? freeFrom(port, this.rows) : port;
    const line = h_flex().flex_none().h(36).px(14).gap(8).items_center().border_b(1).border_color(t.border).text_size(12);
    if (!busy) return line.child(div().size(6).rounded_full().bg(t.done)).child(div().text_color(t.foreground).child(`Порт ${port} свободен`));
    return line
      .child(div().size(6).rounded_full().bg(t.ansi3))
      .child(div().text_color(t.foreground).child(`Порт ${port} занят`))
      .child(div().flex_1())
      .when(free !== null, (el) => el
        .child(div().text_color(t.dim).child("свободен"))
        .child(div().id("free-port").font_family(mono).text_color(t.accent).cursor_pointer().hover((s) => s.text_color(t.foreground))
          .tooltip("Скопировать").on_click((_e, cx) => this.copy(cx, "free", String(free)))
          .child(this.copied === "free" ? "скопировано" : String(free))));
  }

  clashes(t, rows) {
    const ports = [...new Set(rows.filter((r) => r.clash).map((r) => r.port))];
    if (!ports.length) return null;
    return h_flex().flex_none().px(14).py(8).gap(8).items_center().border_b(1).border_color(t.border)
      .text_size(12).text_color(t.ansi3)
      .child(svg(`${ICONS}/warning.svg`).size(14).flex_none())
      .child(div().flex_1().child(`${ports.length > 1 ? "Порты" : "Порт"} ${ports.join(", ")}: слушают несколько процессов`));
  }

  row(t, r, mono) {
    const key = keyOf(r);
    const hover = this.hovered === key;
    const st = this.stopping.get(key);
    const stuck = st && !st.error && st.how === "term" && Date.now() - st.at > STAY;
    const name = r.container?.name ?? r.name;
    const where = r.local ? "локально" : "вся сеть";
    const meta = [`PID ${r.pid}`, r.container ? "контейнер" : null, age(r.age), where].filter(Boolean).join(" · ");
    const url = `http://localhost:${r.port}`;

    let actions = h_flex().flex_none().gap(2).items_center();
    if (st && !st.error && !stuck) {
      actions = actions.child(div().text_size(11.5).text_color(t.dim).loop("opacity", { from: 0.4, to: 1, period: 900 })
        .child(st.how === "docker" ? "docker stop…" : "останавливаю…"));
    } else if (stuck) {
      actions = actions.child(div().text_size(11.5).text_color(t.ansi3).child("не остановился"))
        .child(this.button(t, `kill-${key}`, "zap", "Убить принудительно (SIGKILL)", (cx) => this.stop(cx, r, true), t.blocked));
    } else if (this.confirm === key) {
      actions = actions
        .child(div().id(`yes-${key}`).h(22).px(8).flex().items_center().cursor_pointer().text_size(11.5)
          .bg(t.blocked).text_color(t.background).hover((s) => s.opacity(0.85))
          .on_click((_e, cx) => { cx.stop_propagation(); this.stop(cx, r, false); })
          .child(r.container ? "Остановить контейнер" : "Остановить"))
        .child(this.button(t, `no-${key}`, "x", "Отмена", (cx) => { this.confirm = null; cx.notify(); }));
    } else if (hover) {
      actions = actions
        .child(this.button(t, `open-${key}`, "external", `Открыть ${url}`, (cx) => cx.open_url(url)))
        .child(this.button(t, `copy-${key}`, this.copied === key ? "check" : "copy",
          this.copied === key ? "Скопировано" : `Скопировать localhost:${r.port}`, (cx) => this.copy(cx, key, `localhost:${r.port}`)))
        .when(this.stoppable(r), (el) => el.child(this.button(t, `stop-${key}`, "stop",
          r.container ? `docker stop ${r.container.name}` : `Остановить ${r.name} (SIGTERM)`,
          (cx) => { this.confirm = key; cx.notify(); })));
    }

    return h_flex().id(`row-${key}`).flex_none().min_h(44).pl(14).pr(6).py(6).gap(10).items_center()
      .border_b(1).border_color(t.border + "66")
      .when(hover || this.confirm === key, (el) => el.bg(t.hover))
      .on_hover((h, cx) => { if (h) this.hovered = key; else if (this.hovered === key) this.hovered = null; cx.notify(); })
      .tooltip(r.command)
      .child(div().id(`port-${key}`).w(48).flex_none().font_family(mono).text_size(12.5)
        .text_color(r.clash ? t.ansi3 : t.foreground).cursor_pointer().hover((s) => s.text_color(t.accent))
        .on_click((_e, cx) => cx.open_url(url))
        .child(String(r.port)))
      .child(v_flex().flex_1().min_w(0).gap(2)
        .child(h_flex().gap(6).items_center().min_w(0)
          .child(div().truncate().text_size(12.5).text_color(t.foreground).child(name ?? "?"))
          .when(r.clash, (el) => el.child(svg(`${ICONS}/warning.svg`).size(12).flex_none().text_color(t.ansi3))))
        .child(div().truncate().text_size(11.5).text_color(st?.error ? t.blocked : t.dim)
          .child(st?.error ? `не остановился: ${st.error}` : meta)))
      .child(actions);
  }

  group(t, g, rows, current, mono) {
    const head = h_flex().flex_none().h(30).px(14).gap(8).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .text_size(11.5)
      .child(div().flex_none().text_color(t.foreground).font_medium().child(g.title))
      .when(Boolean(g.branch), (el) => el.child(div().min_w(0).truncate().text_color(t.dim).child(g.branch)))
      .when(Boolean(g.gone), (el) => el.child(div().flex_none().text_color(t.ansi3).child("папка удалена")))
      .child(div().flex_1())
      .when(current, (el) => el.child(div().flex_none().px(6).h(18).flex().items_center().border_1().border_color(t.accent)
        .text_color(t.accent).text_size(11).child("здесь")))
      .child(div().flex_none().text_color(t.dim).child(String(rows.length)))
      .when(Boolean(g.top), (el) => el.tooltip(tilde(g.top, this.home)));
    return v_flex().flex_none().child(head).children(rows.map((r) => this.row(t, r, mono)));
  }

  render(_cx) {
    const t = theme();
    const mono = (typeof settings().font === "string" && settings().font) || "JetBrains Mono";
    const dev = this.rows.filter(isDev);
    const q = this.q;
    // A search looks through everything: the port you need may be held by an app.
    const rows = q
      ? this.rows.filter((r) => String(r.port).startsWith(q)
        || [r.name, r.container?.name, r.cwd, r.git?.branch, r.git?.worktree, r.git?.repo, String(r.pid)]
          .some((x) => x && x.toLowerCase().includes(q)))
      : this.mode === "dev" ? dev : this.rows;

    const cwd = here();
    const groups = new Map();
    for (const r of rows) {
      const g = groupOf(r, this.home);
      const entry = groups.get(g.key) ?? { g, rows: [], current: Boolean(g.top) && inside(cwd, g.top) };
      entry.rows.push(r);
      groups.set(g.key, entry);
    }
    const list = [...groups.values()].sort((a, b) => Number(b.current) - Number(a.current)
      || a.g.order - b.g.order || a.rows[0].port - b.rows[0].port);

    const note = (text, color) => div().px(14).py(14).text_size(12).text_color(color ?? t.dim).child(text);
    return v_flex().id("ports").size_full().min_h(0).overflow_hidden().bg(t.background)
      .border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(this.header(t, dev.length))
      .child(this.search(t))
      .when(Boolean(this.answer(t, mono)), (el) => el.child(this.answer(t, mono)))
      .when(Boolean(this.clashes(t, rows)), (el) => el.child(this.clashes(t, rows)))
      .child(v_flex().id("ports-list").flex_1().min_h(0).overflow_y_scrollbar()
        .when(Boolean(this.error), (el) => el.child(note(this.error ?? "", t.blocked)))
        .when(!this.at && !this.error, (el) => el.child(note("Смотрю порты…")))
        .when(Boolean(this.at) && !rows.length, (el) => el.child(note(q ? "Ничего не нашлось" : "Никто из разработки не слушает порты")))
        .children(list.map(({ g, rows, current }) => this.group(t, g, rows, current, mono))));
  }
}
