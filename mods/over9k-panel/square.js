// Квадратные углы: любое скругление элементов этого мода даёт радиус 0.
// Моды Herdr исполняются раздельно, поэтому правка прототипа не выходит за пределы мода.
// Вызывается из init, а не на верхнем уровне модуля: там элементы ещё нельзя создавать.
import { div, svg, image } from "gpui-kit";

const NAMES = ["rounded", "rounded_t", "rounded_b", "rounded_l", "rounded_r", "rounded_tl", "rounded_tr", "rounded_bl", "rounded_br"];

function patch(proto) {
  if (!proto || proto.__square) return;
  for (const name of NAMES) {
    const original = proto[name];
    if (typeof original === "function") proto[name] = function () { return original.call(this, 0); };
  }
  Object.defineProperty(proto, "__square", { value: true });
}

export function squareCorners() {
  for (const make of [() => div(), () => svg(""), () => image("")]) {
    try { patch(Object.getPrototypeOf(make())); } catch { /* такого элемента нет в этой версии */ }
  }
}
