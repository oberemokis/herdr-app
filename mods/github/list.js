// The Remote tab of the workbench layout: a stack "remote" in the side panel holding
// the GitLab and GitHub panels, of which the one that knows the focused repo shows.
// Each panel splits into sub-tabs (Branch, merge or pull requests, issues, pipelines),
// and a long list loads page by page. Herdr won't import across mods, so mods/gitlab and
// mods/github each have this file: keep both equal (scripts/test/remote-pages.mjs checks).
import { div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { layout, run } from "herdr";

export const REMOTE_STACK = "remote";
export const PAGE = 20;
// A refresh reads the loaded pages again, at most this many; later ones stay as they were.
export const RELOAD_PAGES = 5;

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
// shows another child. A block outside the layout (a test, a floating copy) counts as shown.
export function shown(id) {
  const path = pathTo(layout(), id);
  if (!path) return true;
  return path.every((n, i) => !n.hidden
    && (n.type !== "stack" || i === path.length - 1 || (n.active ?? n.children?.[0]?.id) === path[i + 1].id));
}

// The focused repo belongs to the other host: when both panels share the Remote stack and
// this one is on show, the stack shows the other. Returns whether it switched.
export function showSibling(self, other) {
  const stack = pathTo(layout(), REMOTE_STACK)?.at(-1), ids = (stack?.children ?? []).map((c) => c.id);
  if (stack?.type !== "stack" || !ids.includes(self) || !ids.includes(other)) return false;
  if ((stack.active ?? ids[0]) !== self) return false;
  run("layout.select", { stack: REMOTE_STACK, child: other });
  return true;
}

// One sub-tab's list: the pages loaded so far. `load(after)` reads the page after the cursor
// (null: the first) and gives { items, next, count }; items carry an `id`, and an item a later
// page repeats (the list moved between reads) is dropped.
export class Pager {
  constructor(load) {
    this.load = load;
    this.items = []; this.ends = []; this.next = null; this.done = false; this.count = null;
    // loading: a next page on its way (the list says so); reloading: the loaded ones read again, quietly.
    this.error = null; this.failed = null; this.loading = false; this.reloading = false; this.at = 0; this.gen = 0;
  }

  get pages() { return this.ends.length; }
  get started() { return this.pages > 0 || this.loading || Boolean(this.error); }
  get canMore() { return !this.done && !this.loading && !this.reloading && !this.error; }

  // What failed, once more.
  retry(cx) {
    const failed = this.failed;
    this.error = null; this.failed = null;
    failed === "reload" ? this.reload(cx) : this.more(cx);
  }

  // The next page; an empty one (everything on it filtered out) goes on to the one after.
  more(cx) {
    if (this.loading || this.reloading || this.done) return;
    const gen = ++this.gen;
    this.loading = true; this.error = null;
    cx.spawn(async (cx) => {
      try {
        for (let tries = 0; tries < 3; tries++) {
          const page = await this.load(this.next);
          if (gen !== this.gen) return;
          const added = this.append(page);
          if (added || this.done) break;
        }
      } catch (e) { if (gen === this.gen) { this.error = e.message; this.failed = "more"; } }
      if (gen !== this.gen) return;
      this.loading = false; this.at = Date.now();
      cx.notify();
    });
  }

  append(page) {
    const seen = new Set(this.items.map((x) => x.id)), before = this.items.length;
    for (const x of page.items) if (!seen.has(x.id)) { seen.add(x.id); this.items.push(x); }
    this.ends.push(this.items.length);
    this.next = page.next ?? null; this.done = !this.next;
    if (page.count != null) this.count = page.count;
    return this.items.length - before;
  }

  // The loaded pages read again from the start, up to RELOAD_PAGES; the rows keep their ids,
  // so the scroll stays where it was. A failed read keeps the old rows.
  reload(cx) {
    if (this.loading || this.reloading) return;
    if (!this.pages) { this.error = null; this.more(cx); return; }
    const gen = ++this.gen, pages = Math.min(this.pages, RELOAD_PAGES);
    this.reloading = true;
    cx.spawn(async (cx) => {
      try {
        const items = [], ends = [], seen = new Set();
        let next = null, count = this.count;
        for (let i = 0; i < pages; i++) {
          const page = await this.load(next);
          if (gen !== this.gen) return;
          for (const x of page.items) if (!seen.has(x.id)) { seen.add(x.id); items.push(x); }
          ends.push(items.length);
          next = page.next ?? null;
          if (page.count != null) count = page.count;
          if (!next) break;
        }
        if (ends.length === pages && this.pages > pages) {
          // Pages past the re-read ones stay, minus what moved up into them.
          const old = this.ends[pages - 1];
          for (const end of this.ends.slice(pages)) {
            for (const x of this.items.slice(old, end)) if (!seen.has(x.id)) { seen.add(x.id); items.push(x); }
            ends.push(items.length);
          }
        } else this.next = next;
        this.items = items; this.ends = ends; this.done = !this.next; this.count = count; this.error = null; this.failed = null;
      } catch (e) { if (gen === this.gen) { this.error = e.message; this.failed = "reload"; } }
      if (gen !== this.gen) return;
      this.reloading = false; this.at = Date.now();
      cx.notify();
    });
  }
}

// The sub-tabs under the panel header: [{ id, label, count }].
export function tabStrip(t, prefix, tabs, current, pick) {
  const tab = ({ id, label, count }) => h_flex().id(`${prefix}-tab-${id}`).h(22).px(8).gap(5).flex_none().items_center().rounded(5)
    .text_size(12).cursor_pointer()
    .bg(current === id ? t.raised : t.background).text_color(current === id ? t.foreground : t.muted)
    .when(current === id, (e) => e.border_1().border_color(t.border).font_semibold())
    .hover((s) => s.text_color(t.foreground))
    .on_click((_e, cx) => { if (current !== id) pick(id, cx); })
    .child(label)
    .when(count != null, (e) => e.child(div().text_size(11).text_color(t.dim).child(String(count))));
  return h_flex().id(`${prefix}-tabs`).flex_none().mx(8).mt(8).p(1).gap(1).items_center().rounded(7)
    .bg(t.background).border_1().border_color(t.border).overflow_x_scroll()
    .children(tabs.map(tab));
}

// A label's own colour, as the theme's nearest: red, yellow, green, cyan, blue or magenta by
// hue; a greyish or missing one, the theme's muted.
export function labelTone(hex, t) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(hex ?? "");
  if (!m) return t.muted;
  const [r, g, b] = m.slice(1).map((x) => parseInt(x, 16) / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (d < 0.15) return t.muted;
  const h = (max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4) * 60;
  return h < 20 || h >= 330 ? t.ansi1 : h < 70 ? t.ansi3 : h < 165 ? t.ansi2 : h < 200 ? t.ansi6 ?? t.ansi4 : h < 260 ? t.ansi4 : t.ansi5;
}

// An issue's label: a round pill in the theme's colours, its own colour kept as a dot. The dot
// sits in the centre of the pill's left end ((16 - 6) / 2 = 5 from each edge), and the text
// has the same 5 to the right end; the text's line fills the inside (16 less the border), so the
// text and the dot centre on one line.
export function labelPill(t, id, label) {
  return h_flex().id(id).h(16).px(5).gap(4).flex_none().items_center().rounded_full().border_1().border_color(t.border).bg(t.raised)
    .text_size(10.5).line_height("14px").text_color(t.muted)
    .child(div().size(6).flex_none().rounded_full().bg(labelTone(label.color, t)))
    .child(div().max_w(110).truncate().child(label.title));
}

// A list's state filter: [[id, label]].
export function filterRow(t, prefix, options, current, pick) {
  return h_flex().flex_none().px(8).pt(8).pb(2).gap(12).items_center().text_size(11.5)
    .children(options.map(([id, label]) => div().id(`${prefix}-filter-${id}`).cursor_pointer()
      .text_color(current === id ? t.foreground : t.dim).when(current === id, (e) => e.font_medium())
      .hover((s) => s.text_color(t.foreground))
      .on_click((_e, cx) => { if (current !== id) pick(id, cx); })
      .child(label)));
}

// The row under a list: more to load, loading, or what went wrong with a way to try again.
export function moreRow(t, prefix, pager) {
  if (pager.error) {
    return h_flex().id(`${prefix}-more`).px(8).py(6).gap(8).flex_none().items_start().text_size(12)
      .child(div().flex_1().min_w(0).text_color(t.ansi1).whitespace_normal().child(pager.error))
      .child(div().id(`${prefix}-retry`).flex_none().text_color(t.dim).cursor_pointer().hover((s) => s.text_color(t.foreground))
        .on_click((_e, cx) => { pager.retry(cx); cx.notify(); })
        .child("Try again"));
  }
  if (pager.loading) return div().px(8).py(6).flex_none().text_size(12).text_color(t.dim).child("Loading…");
  if (pager.done) return null;
  return div().id(`${prefix}-more`).px(8).py(6).flex_none().text_size(12).text_color(t.dim).cursor_pointer()
    .hover((s) => s.text_color(t.foreground))
    .on_click((_e, cx) => { pager.more(cx); cx.notify(); })
    .child("Load more");
}
