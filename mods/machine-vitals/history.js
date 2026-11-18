// One history for every copy of this mod: the sidebar samples, the monitor window reads
// the same hour back. Module code is shared by a mod's copies, so this object is too;
// saving any file of the mod starts it over.
import { exec } from "herdr";
import { SCRIPT, parse } from "./stats.js";

export const HOUR = 3_600_000;
// A sample takes about a second (iostat waits one). One running longer is lost: the copy
// that started it closed while it ran (the monitor window), and its finally never came.
const STUCK = 10_000;

export const store = {
  samples: [], // { t, cpu, mem, rx, tx }, oldest first, the last hour
  now: null, // the last parse() result, with rx/tx rates added
  error: null,
  busy: 0, // when the running sample started, 0 when none runs
  last: 0,
  net: null, // the previous byte counters, for rates
};

// Samples unless one is running or the last is younger than `every` ms.
// Resolves true when a new sample landed.
export async function sample(every) {
  const started = Date.now();
  if ((store.busy && started - store.busy < STUCK) || started - store.last < every - 100) return false;
  store.busy = started;
  store.last = started;
  try {
    const s = parse((await exec("sh", ["-c", SCRIPT], { timeout: STUCK - 2000 })).stdout);
    const t = Date.now();
    const prev = store.net;
    const dt = prev ? (t - prev.t) / 1000 : 0;
    const fresh = s.net && prev && dt > 0 && s.net.rx >= prev.rx && s.net.tx >= prev.tx;
    s.rx = fresh ? (s.net.rx - prev.rx) / dt : null;
    s.tx = fresh ? (s.net.tx - prev.tx) / dt : null;
    if (s.net) store.net = { t, ...s.net };
    store.now = s;
    store.error = null;
    store.samples.push({ t, cpu: s.cpu, mem: s.mem.used, rx: s.rx, tx: s.tx });
    while (store.samples.length && store.samples[0].t < t - HOUR) store.samples.shift();
    return true;
  } catch (e) {
    store.error = String(e);
    return true;
  } finally {
    if (store.busy === started) store.busy = 0;
  }
}
