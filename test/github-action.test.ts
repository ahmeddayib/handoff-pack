import { describe, expect, it, vi } from "vitest";
import { GitHubClient } from "../src/action/github.js";

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status });
}

describe("GitHub Action REST client", () => {
  it("updates an existing runbook PR instead of creating another", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock
      .mockResolvedValueOnce(response({ default_branch: "main" }))
      .mockResolvedValueOnce(
        response([
          {
            number: 12,
            html_url: "https://github.com/acme/app/pull/12",
            head: { ref: "handoff-pack/update-20260925" },
            base: { ref: "main" },
          },
        ]),
      )
      .mockResolvedValueOnce(response({ object: { sha: "old" } }))
      .mockResolvedValueOnce(response({ tree: { sha: "old-tree" } }))
      .mockResolvedValueOnce(response({ sha: "new-tree" }))
      .mockResolvedValueOnce(response({ sha: "new-commit" }))
      .mockResolvedValueOnce(response({ object: { sha: "new-commit" } }))
      .mockResolvedValueOnce(response({ number: 12 }));
    const client = new GitHubClient("acme/app", "test-token", fetchMock);
    const pull = await client.upsertRunbookPull(
      [{ path: "handoff/handoff.json", content: "{}" }],
      "+ finding: example\n",
      "20260925",
    );
    expect(pull.number).toBe(12);
    expect(
      fetchMock.mock.calls.filter(
        ([url, init]) =>
          String(url).endsWith("/pulls") && init?.method === "POST",
      ),
    ).toHaveLength(0);
    expect(
      fetchMock.mock.calls.some(
        ([url, init]) =>
          String(url).endsWith("/pulls/12") && init?.method === "PATCH",
      ),
    ).toBe(true);
  });

  it("reuses a matching open deprecation issue", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      response([
        {
          title: "Model openai/example retires on 2026-12-01",
          html_url: "https://github.com/acme/app/issues/8",
        },
      ]),
    );
    const client = new GitHubClient("acme/app", "test-token", fetchMock);
    const url = await client.openDeprecationIssue(
      "Model openai/example retires on 2026-12-01",
      "details",
    );
    expect(url).toBe("https://github.com/acme/app/issues/8");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("creates a runbook PR when none is open", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock
      .mockResolvedValueOnce(response({ default_branch: "main" }))
      .mockResolvedValueOnce(response([]))
      .mockResolvedValueOnce(response({}, 404))
      .mockResolvedValueOnce(response({ object: { sha: "base" } }))
      .mockResolvedValueOnce(response({ object: { sha: "base" } }))
      .mockResolvedValueOnce(response({ tree: { sha: "base-tree" } }))
      .mockResolvedValueOnce(response({ sha: "new-tree" }))
      .mockResolvedValueOnce(response({ sha: "new-commit" }))
      .mockResolvedValueOnce(response({ object: { sha: "new-commit" } }))
      .mockResolvedValueOnce(
        response({
          number: 19,
          html_url: "https://github.com/acme/app/pull/19",
        }),
      );
    const client = new GitHubClient("acme/app", "test-token", fetchMock);
    const pull = await client.upsertRunbookPull(
      [{ path: "handoff/HANDOFF.md", content: "# Runbook" }],
      "+ finding: example\n",
      "20260925",
    );
    expect(pull.number).toBe(19);
    expect(
      fetchMock.mock.calls.some(
        ([url, init]) =>
          String(url).endsWith("/pulls") && init?.method === "POST",
      ),
    ).toBe(true);
  });

  it("creates one labeled issue when no match is open", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response([]))
      .mockResolvedValueOnce(
        response({ name: "handoff-pack:deprecation" }, 201),
      )
      .mockResolvedValueOnce(
        response({ html_url: "https://github.com/acme/app/issues/9" }, 201),
      );
    const client = new GitHubClient("acme/app", "test-token", fetchMock);
    const url = await client.openDeprecationIssue(
      "Model openai/example retires on 2026-12-01",
      "details",
    );
    expect(url).toBe("https://github.com/acme/app/issues/9");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
