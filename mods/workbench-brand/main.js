// The sidebar's top row: empty space to drag the window by, and the button that folds the sidebar to a
// rail and back. On the macOS rail the window buttons fill the row's top, so the row
// grows (BRAND_RAIL) and the button sits under them, in the middle of the rail.
import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, run, window, shared, setShared, layout } from "herdr";
import { squareCorners } from "./square.js";

const BRAND = 42;
const BRAND_RAIL = 78;

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

const macos = () => window()?.platform === "macos" && !window()?.fullscreen;
// The sidebar's rail goes by its width, not a flag.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

// To the rail (on macOS wide enough for the traffic lights), or back to the width it had.
function toggleSidebar() {
  const fold = !narrow();
  if (fold) setShared("sidebar.width", find(layout(), "sidebar")?.size?.px);
  // Mods edited before the rail went by width still read the flag.
  setShared("sidebar.collapsed", fold);
  run("layout.resize", { id: "sidebar", px: fold ? (window()?.platform === "macos" ? 76 : 44) : (shared("sidebar.width") ?? 268) });
  run("layout.resize", { id: "brand", px: fold && macos() ? BRAND_RAIL : BRAND });
}

export default class WorkbenchBrand extends View {
  init() {
    squareCorners();
  }

  render() {
    const t = theme();
    const rail = narrow();
    const button = div().id("sidebar-toggle").size(28).flex_none().flex().items_center().justify_center().rounded(6).cursor_pointer()
      .text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
      .tooltip(rail ? "Expand sidebar" : "Collapse sidebar")
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click(toggleSidebar)
      .child(svg("mods/workspace-chrome/sidebar.svg").size(15));
    if (rail) return v_flex().size_full().bg(t.chrome).items_center().justify_end().pb(7).child(button);
    return h_flex().size_full().bg(t.chrome).pl(macos() ? 76 : 14).pr(10).items_center().justify_end()
      .child(button);
  }
}
