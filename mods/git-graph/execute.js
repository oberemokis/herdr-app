// Action execution is separate from the UI so it can be tested against
// disposable repositories. exec has Herdr's (program, argv, options) shape.
import { commandsFor, gitError } from "./git.js";

export async function executeAction(action, ctx, exec) {
  // Граф только смотрит: менять репозиторий может лишь агент, а не клик в панели.
  if (action.type !== "fetch") return { ok: false, message: "Read-only: only Fetch is allowed." };
  // As manygit fetches: saved credentials and SSH's own configuration still work,
  // but nothing may stop to ask for a login. Git tries askpass before
  // GIT_TERMINAL_PROMPT, so an empty GIT_ASKPASS goes with it.
  for (const args of commandsFor(action)) {
    const result = await exec("env", ["GCM_INTERACTIVE=0", "GIT_TERMINAL_PROMPT=0", "GIT_ASKPASS=", "git", ...args], { cwd: ctx.root, on: ctx.on });
    if (result.code !== 0) return { ok: false, message: gitError(result) };
  }
  return { ok: true };
}
