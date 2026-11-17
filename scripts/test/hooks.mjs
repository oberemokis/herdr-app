// Points the mods' imports of herdr, gpui-kit and gpui-base at herdr-shim.mjs.
import { registerHooks } from "node:module";

const shim = new URL("./herdr-shim.mjs", import.meta.url).href;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "herdr" || specifier === "gpui-kit" || specifier === "gpui-base") return { url: shim, shortCircuit: true };
    return next(specifier, context);
  },
});
