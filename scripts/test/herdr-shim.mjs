// Stand-ins for the modules Herdr gives a mod, so api.js and list.js run under node.
// exec runs the command for real; the rest only has to exist.
import { spawn } from "node:child_process";

export function exec(cmd, args, { cwd } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd: cwd ?? process.cwd() });
    let stdout = "", stderr = "";
    p.stdout.on("data", (d) => { stdout += d; });
    p.stderr.on("data", (d) => { stderr += d; });
    p.on("error", reject);
    p.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

export const setShared = () => {};
export const shared = () => null;
export const spaces = () => [];
export const layout = () => null;
export const run = () => {};

// gpui-kit and gpui-base: any element call returns another element.
const element = () => new Proxy(function () {}, { get: () => element, apply: () => element() });
export const div = element;
export const h_flex = element;
export const v_flex = element;
