// Made-up data for screenshots: a block with props { demo: true } shows it instead of a repo.
// Nothing here talks to git or GitHub. Shapes as api.js returns them.

const at = (minutes) => new Date(Date.now() - minutes * 60000).toISOString();
const web = "https://github.com/acme/storefront";
let ids = 0;

function job(name, status, sec, runId) {
  return {
    id: String(++ids), name, status, url: `${web}/actions/runs/${runId}/job/${ids}`, startedAt: sec ? at(Math.ceil(sec / 60)) : status === "RUNNING" ? at(2) : null,
    endedAt: null, duration: sec, log: true, runId, retryable: status === "FAILED" || status === "CANCELED",
  };
}

function checks(sha, title, minutes, status, stages) {
  return {
    id: `checks-${sha}`, label: "Checks", status, ref: "", url: `${web}/commit/${sha}`, createdAt: at(minutes), startedAt: at(minutes), duration: null,
    user: null, commit: { shortId: sha, title },
    stages: stages.map(([name, runId, list]) => ({ name, jobs: list.map(([n, s, sec]) => job(n, s, sec, runId)) })),
    runs: stages.map(([, runId]) => ({ id: runId, status })),
  };
}

function run(id, name, number, status, branch, title, minutes, duration, user = "dana") {
  return {
    id: `run-${id}`, runId: id, label: `${name} #${number}`, status, ref: branch, url: `${web}/actions/runs/${id}`,
    createdAt: at(minutes), startedAt: at(minutes), duration, user: { username: user },
    commit: { shortId: (id * 2654435761 % 0xfffffff).toString(16).padStart(7, "0").slice(0, 7), title },
    stages: [{ name: "", jobs: [job("lint", "SUCCESS", 41, id), job("test", status === "RUNNING" ? "RUNNING" : status, duration, id)] }],
    runs: [{ id, status }],
  };
}

function pr(number, title, branch, author, minutes, status, add, del, head, extra = {}) {
  return {
    id: `PR_demo${number}`, iid: String(number), title, state: "opened", draft: status === "DRAFT_STATUS",
    webUrl: `${web}/pull/${number}`, createdAt: at(minutes * 3), updatedAt: at(minutes),
    sourceBranch: branch, targetBranch: "main", headSha: "0", crossRepo: false, detailedMergeStatus: status,
    author: { username: author }, reviewers: { nodes: [] }, approvedBy: { nodes: [] }, myApproval: null,
    userPermissions: { canMerge: true, canApprove: author !== "dana", canDismiss: true, updateMergeRequest: true, createNote: true },
    diffStatsSummary: { additions: add, deletions: del, fileCount: 7 }, resolvableDiscussionsCount: 0, resolvedDiscussionsCount: 0,
    headPipeline: head, ...extra,
  };
}

export function demoState() {
  const running = checks("4f2a9c1", "feat(checkout): retry failed payments with backoff", 6, "RUNNING", [
    ["CI", 9101, [["lint", "SUCCESS", 38], ["unit", "SUCCESS", 131], ["e2e", "RUNNING", null]]],
    ["Deploy preview", 9102, [["preview", "PENDING", null]]],
  ]);
  const mine = pr(128, "feat(checkout): retry failed payments with backoff", "feat/checkout-retry", "dana", 6, "CI_STILL_RUNNING", 214, 38, running,
    { resolvableDiscussionsCount: 3, resolvedDiscussionsCount: 2 });
  const prs = [
    mine,
    pr(126, "fix(cart): keep the coupon after a currency switch", "fix/coupon-currency", "lee", 52, "MERGEABLE", 31, 9,
      { status: "SUCCESS" }, { reviewers: { nodes: [{ username: "dana" }] } }),
    pr(121, "search with typo tolerance", "feat/fuzzy-search", "sam", 180, "DRAFT_STATUS", 488, 120, { status: "FAILED" }),
    pr(117, "chore(deps): bump vite to 7.2", "renovate/vite-7.x", "renovate[bot]", 1440, "CONFLICT", 12, 12, { status: "SUCCESS" }),
  ];
  const pipelines = [
    run(9101, "CI", 412, "RUNNING", "feat/checkout-retry", "feat(checkout): retry failed payments with backoff", 6, null),
    run(9095, "CI", 411, "SUCCESS", "main", "Merge pull request #124 from acme/fix/tax-rounding", 34, 486),
    run(9090, "CI", 409, "SUCCESS", "fix/coupon-currency", "fix(cart): keep the coupon after a currency switch", 52, 397, "lee"),
    run(9081, "CI", 405, "FAILED", "main", "Merge pull request #119 from acme/feat/gift-cards", 190, 233),
    run(9077, "Release", 58, "CANCELED", "main", "chore: release 2.14.0", 300, 40),
    run(9070, "CI", 401, "FAILED", "feat/fuzzy-search", "search: typo tolerance (wip)", 200, 95, "sam"),
  ];
  const issue = (number, title, who, minutes, labels) => ({
    iid: String(number), title, description: "Steps to reproduce, expected and actual behaviour.", webUrl: `${web}/issues/${number}`,
    updatedAt: at(minutes), author: { username: "lee" }, assignees: { nodes: who ? [{ username: who }] : [] },
    labels: { nodes: labels.map(([title, color]) => ({ title, color })) },
  });
  const issues = [
    issue(342, "Payment retries double-charge on slow 3-D Secure", "dana", 20, [["bug", "#d73a4a"], ["checkout", "#3e63dd"]]),
    issue(339, "Show delivery estimates on the product page", null, 260, [["enhancement", "#a2eeef"]]),
    issue(331, "Flaky e2e: cart badge count after login", "sam", 900, [["flaky", "#f5a524"], ["ci", "#8e4ec6"]]),
  ];
  return {
    host: "github.com", path: "acme/storefront", root: "/tmp", on: null, remote: "origin", web, origin: "https://github.com",
    main: "main", me: "dana", branch: "feat/checkout-retry", branchMr: mine, branchPipeline: running,
    mrs: prs, mrCount: prs.length, pipelines, issues, issueCount: issues.length, error: null,
  };
}
