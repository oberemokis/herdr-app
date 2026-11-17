import { exec, notify, setShared } from "herdr";
import { doneText } from "./git.js";
import { executeAction } from "./execute.js";

// Runs an action (Fetch). Every graph copy refreshes after, whether or not its
// folder watch saw the change, and so does Review ("git-graph.changed").
export async function perform(action, ctx) {
  try {
    const result = await executeAction(action, ctx, exec);
    if (!result.ok) {
      notify({ title: "Couldn't do that", body: result.message, level: "error" });
      return result;
    }
    notify({ title: doneText(action), level: "success", timeout: 3000 });
    return { ok: true };
  } catch (e) {
    const message = String(e?.message ?? e);
    notify({ title: "Git didn't run", body: message, level: "error" });
    return { ok: false, message };
  } finally {
    setShared("git-graph.changed", Date.now());
  }
}
