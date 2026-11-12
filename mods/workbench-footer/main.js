import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, run, props, updates, layout, openOverlay, closeOverlay } from "herdr";
import { squareCorners } from "./square.js";

// Подвал сайдбара из workspace-chrome Herdr 0.1.15. Settings открывает меню с настройками
// Herdr и over9k: в само окно Settings Herdr моды встраиваться не могут.

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The sidebar's rail goes by its width, not a flag: dragging its edge narrows it too.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;
const icon = (name) => `mods/workspace-chrome/${name}.svg`;

const openSettingsMenu = () => openOverlay({ mod: "workbench-footer", kind: "popup", width: 200, height: 76, props: { menu: true } });
const openOver9k = () => openOverlay({ mod: "over9k-options", kind: "dialog", width: 740, height: 600 });

export default class WorkbenchFooter extends View {
  init() { squareCorners(); }

  render() {
    const t = theme();
    const ready = () => div().size(6).rounded_full().bg(t.accent);
    if (props()?.menu) {
      const overlay = props().overlay;
      const item = (id, glyph, label, action, dot) => h_flex().id(id).h(30).px(10).gap(9).items_center().rounded(6).cursor_pointer()
        .text_color(t.foreground).hover(s => s.bg(t.hover))
        .on_click(() => { closeOverlay(overlay); action(); })
        .child(svg(icon(glyph)).size(14).text_color(t.muted)).child(div().flex_1().child(label))
        .when(dot, el => el.child(ready()));
      return v_flex().size_full().p(5).gap(2).bg(t.popover).text_size(13)
        .child(item("settings-herdr", "settings", "Herdr", () => run("app.settings"), Boolean(updates().app.ready)))
        .child(item("settings-over9k", "layers", "Over9k", openOver9k, false));
    }
    const collapsed = narrow();
    const row = (id, glyph, label, dim, action) => h_flex().id(id).h(28).px(8).gap(9).items_center().rounded(8)
      .when(collapsed, el => el.relative().w(32).px(0).justify_center().tooltip(label))
      .text_color(dim ? t.dim : t.muted).hover(s => s.bg(t.hover).text_color(t.foreground)).cursor_pointer()
      .on_click(action).child(svg(icon(glyph)).size(14))
      .when(!collapsed, el => el.child(label));
    return v_flex().size_full().bg(t.chrome).border_t(1).border_color(t.border).px(8).pt(4).pb(8).text_size(13)
      .when(collapsed, el => el.px(0).items_center())
      .child(row("settings", "settings", "Settings", false, openSettingsMenu)
        .when(Boolean(updates().app.ready), el => el.child(collapsed ? ready().absolute().top(5).right(6) : ready())))
      .child(row("machine", "plus", "Add machine", true, () => run("mod.open", { name: "machine-add" })));
  }
}
