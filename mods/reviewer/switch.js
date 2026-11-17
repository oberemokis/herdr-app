// The Git tab of the workbench layout: a stack "git" in the side panel holding
// Review (this mod) and Graph (git-graph). Both headers draw this same switch,
// so the tab reads as one; it selects the stack's child, and workbench-tabs
// remembers the choice per space. The same file lives in mods/git-graph.
import { div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { layout, run } from "herdr";

export const GIT_STACK = "git";
const VIEWS = [["review", "Review"], ["graph", "Graph"]];

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) { const found = find(child, id); if (found) return found; }
  return null;
}

// Whether the layout has the Git tab, with both views in it.
export function inGitTab() {
  const stack = find(layout(), GIT_STACK);
  return stack?.type === "stack" && VIEWS.every(([id]) => (stack.children ?? []).some((c) => c.id === id));
}

export function viewSwitch(t, current) {
  const segment = (id, label) => div().id(`git-view-${id}`).h(20).px(8).flex().items_center().rounded(5).text_size(12).cursor_pointer()
    .bg(current === id ? t.raised : t.background).text_color(current === id ? t.foreground : t.muted)
    .when(current === id, (e) => e.border_1().border_color(t.border).font_semibold())
    .hover((s) => s.text_color(t.foreground))
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_click(() => { if (current !== id) run("layout.select", { stack: GIT_STACK, child: id }); })
    .child(label);
  return h_flex().flex_none().p(1).gap(1).items_center().rounded(7).bg(t.background).border_1().border_color(t.border)
    .children(VIEWS.map(([id, label]) => segment(id, label)));
}
