import { View } from "gpui-kit";
import { props } from "herdr";
import { squareCorners } from "./square.js";
import { Graph } from "./graph.js";
import { Menu } from "./menu.js";
import { Settings } from "./settings.js";

// One mod, several roles: the graph (a panel or a pane), and over the window the
// right-click menu and the Manygit settings (props.role).
export default class GitGraph extends View {
  init(_props, cx) {
    squareCorners();
    const role = props()?.role;
    this.part = role === "menu" ? new Menu() : role === "settings" ? new Settings() : new Graph();
    this.part.init(cx);
  }

  render(cx) { return this.part.render(cx); }
}
