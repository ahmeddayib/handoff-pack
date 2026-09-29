export interface PullRequest {
  number: number;
  html_url: string;
  head: { ref: string };
  base: { ref: string };
}

type Ref = { object: { sha: string } };
type Commit = { tree: { sha: string } };
type Sha = { sha: string };
type Repository = { default_branch: string };
type Issue = { title: string; html_url: string; pull_request?: object };

export class GitHubClient {
  private readonly root: string;

  constructor(
    repository: string,
    private readonly token: string,
    private readonly requestFetch: typeof fetch = fetch,
  ) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repository))
      throw new Error("GITHUB_REPOSITORY must be owner/repo.");
    this.root = `https://api.github.com/repos/${repository}`;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: object,
  ): Promise<T> {
    const response = await this.requestFetch(`${this.root}${path}`, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok)
      throw new Error(
        `GitHub API ${method} ${path} returned ${response.status}.`,
      );
    return (await response.json()) as T;
  }

  async defaultBranch(): Promise<string> {
    return (await this.request<Repository>("GET", "")).default_branch;
  }

  async openRunbookPull(base: string): Promise<PullRequest | null> {
    const pulls: PullRequest[] = [];
    for (let page = 1; ; page++) {
      const batch = await this.request<PullRequest[]>(
        "GET",
        `/pulls?state=open&per_page=100&page=${page}`,
      );
      pulls.push(...batch);
      if (batch.length < 100) break;
    }
    return (
      pulls.find(
        (pull) =>
          pull.head.ref.startsWith("handoff-pack/update-") &&
          pull.base.ref === base,
      ) ?? null
    );
  }

  async upsertRunbookPull(
    files: { path: string; content: string }[],
    summary: string,
    today: string,
  ): Promise<PullRequest> {
    const base = await this.defaultBranch();
    const existing = await this.openRunbookPull(base);
    const branch = existing?.head.ref ?? `handoff-pack/update-${today}`;
    const refPath = `/git/ref/heads/${encodeURIComponent(branch)}`;
    let branchRef: Ref | null = null;
    try {
      branchRef = await this.request<Ref>("GET", refPath);
    } catch (error) {
      if (!(error instanceof Error && error.message.endsWith("returned 404.")))
        throw error;
    }
    if (!branchRef) {
      const baseRef = await this.request<Ref>(
        "GET",
        `/git/ref/heads/${encodeURIComponent(base)}`,
      );
      branchRef = await this.request<Ref>("POST", "/git/refs", {
        ref: `refs/heads/${branch}`,
        sha: baseRef.object.sha,
      });
    }
    const parent = branchRef.object.sha;
    const baseTree = (
      await this.request<Commit>("GET", `/git/commits/${parent}`)
    ).tree.sha;
    const tree = await this.request<Sha>("POST", "/git/trees", {
      base_tree: baseTree,
      tree: files.map((file) => ({
        path: file.path,
        mode: "100644",
        type: "blob",
        content: file.content,
      })),
    });
    const commit = await this.request<Sha>("POST", "/git/commits", {
      message: "Update handoff runbook",
      tree: tree.sha,
      parents: [parent],
    });
    await this.request<Ref>("PATCH", refPath, {
      sha: commit.sha,
      force: false,
    });
    if (existing) {
      await this.request<PullRequest>("PATCH", `/pulls/${existing.number}`, {
        body: summary,
      });
      return existing;
    }
    return this.request<PullRequest>("POST", "/pulls", {
      title: `Runbook update: ${summary.split("\n").filter(Boolean).length} changes`,
      head: branch,
      base,
      body: summary,
    });
  }

  async openDeprecationIssue(title: string, body: string): Promise<string> {
    const issues: Issue[] = [];
    for (let page = 1; ; page++) {
      const batch = await this.request<Issue[]>(
        "GET",
        `/issues?state=open&labels=handoff-pack%3Adeprecation&per_page=100&page=${page}`,
      );
      issues.push(...batch);
      if (batch.length < 100) break;
    }
    const existing = issues.find(
      (issue) => !issue.pull_request && issue.title === title,
    );
    if (existing) return existing.html_url;
    try {
      await this.request("POST", "/labels", {
        name: "handoff-pack:deprecation",
        color: "d93f0b",
      });
    } catch (error) {
      if (!(error instanceof Error && error.message.endsWith("returned 422.")))
        throw error;
    }
    const issue = await this.request<Issue>("POST", "/issues", {
      title,
      body,
      labels: ["handoff-pack:deprecation"],
    });
    return issue.html_url;
  }
}
