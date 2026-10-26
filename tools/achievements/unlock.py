"""Earn GitHub profile achievements by scripting real activity on a sandbox repo.

Adapted from XTUFE/GitHub-Achievement-Unlocker, with the rough edges removed:
the token comes from the environment instead of the source, every run is
bounded, the base branch is looked up rather than assumed to be ``main``,
branches are deleted after merging, rate limits are waited out instead of
crashing, and commits carry ``[skip ci]`` so the sandbox does not burn
Actions minutes. Standard library only.

Point it at a throwaway repository, never at a project you care about:

    export ACHIEVEMENTS_TOKEN=github_pat_...
    python tools/achievements/unlock.py pull-shark --repo you/sandbox --count 16

Achievements it can drive (tiers are GitHub's):

    pull-shark           merged pull requests                    2 / 16 / 128 / 1024
    pair-extraordinaire  merged PRs with a co-authored commit    1 / 10 / 24 / 48
    quickdraw            issue closed within 5 minutes           1
    yolo                 PR merged before its requested review   1
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

API = "https://api.github.com"
FILENAME = "ACHIEVEMENTS.md"
# GitHub allows ~500 content-creating requests an hour and a PR cycle makes
# four, so anything much faster than this trips the secondary rate limit.
DEFAULT_DELAY = 30.0


class HTTPError(Exception):
    def __init__(self, method: str, path: str, code: int, detail: str):
        super().__init__(f"{method} {path} failed: HTTP {code} {detail}")
        self.code = code


class GitHub:
    def __init__(self, token: str, repo: str, api: str = API):
        self.token = token
        self.repo = repo
        self.api = api.rstrip("/")

    def request(self, method: str, path: str, body: dict | None = None, attempts: int = 6):
        url = f"{self.api}/repos/{self.repo}{path}"
        data = json.dumps(body).encode() if body is not None else None
        for attempt in range(attempts):
            req = urllib.request.Request(url, data=data, method=method)
            req.add_header("Authorization", f"Bearer {self.token}")
            req.add_header("Accept", "application/vnd.github+json")
            req.add_header("X-GitHub-Api-Version", "2022-11-28")
            req.add_header("User-Agent", "aad-greeks-achievements")
            if data is not None:
                req.add_header("Content-Type", "application/json")
            try:
                with urllib.request.urlopen(req, timeout=30) as resp:
                    raw = resp.read()
                    return json.loads(raw) if raw else {}
            except urllib.error.HTTPError as err:
                wait = retry_after(err, attempt)
                if wait is None or attempt == attempts - 1:
                    detail = err.read().decode(errors="replace")[:300]
                    raise HTTPError(method, path, err.code, detail) from None
                print(f"  HTTP {err.code} on {method} {path}; retrying in {wait:.0f}s")
                time.sleep(wait)
            except urllib.error.URLError as err:
                if attempt == attempts - 1:
                    raise
                print(f"  {err.reason} on {method} {path}; retrying")
                time.sleep(2 ** (attempt + 1))
        raise AssertionError("unreachable")

    def default_branch(self) -> str:
        return self.request("GET", "")["default_branch"]

    def file_sha(self, branch: str) -> str | None:
        try:
            return self.request("GET", f"/contents/{FILENAME}?ref={branch}", attempts=1)["sha"]
        except HTTPError as err:
            if err.code == 404:
                return None
            raise


def retry_after(err: urllib.error.HTTPError, attempt: int) -> float | None:
    """Seconds to wait before retrying, or None if the error is final."""
    headers = err.headers
    if err.code in (403, 429):
        if headers.get("Retry-After"):
            return float(headers["Retry-After"])
        if headers.get("X-RateLimit-Remaining") == "0" and headers.get("X-RateLimit-Reset"):
            return max(1.0, float(headers["X-RateLimit-Reset"]) - time.time() + 1)
        # secondary rate limits sometimes arrive without either header
        return 60.0 * (attempt + 1) if err.code == 429 else None
    # 405/409: the merge raced GitHub's mergeability check; 5xx: transient
    if err.code in (405, 409) or err.code >= 500:
        return float(2 ** (attempt + 1))
    return None


def open_pr(gh: GitHub, base: str, label: str, coauthor: str | None = None) -> tuple[int, str]:
    """Branch off ``base``, change one file and open a PR; returns (number, branch)."""
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    branch = f"achievements/{label}-{stamp}"
    sha = gh.request("GET", f"/git/ref/heads/{base}")["object"]["sha"]
    gh.request("POST", "/git/refs", {"ref": f"refs/heads/{branch}", "sha": sha})

    message = f"{label}: {stamp} [skip ci]"
    if coauthor:
        message += f"\n\nCo-authored-by: {coauthor}"
    body = {
        "message": message,
        "content": base64.b64encode(f"Last run: {label} at {stamp}\n".encode()).decode(),
        "branch": branch,
    }
    if file_sha := gh.file_sha(branch):
        body["sha"] = file_sha
    gh.request("PUT", f"/contents/{FILENAME}", body)

    pr = gh.request("POST", "/pulls", {"title": f"{label} {stamp}", "head": branch, "base": base})
    return pr["number"], branch


def merge(gh: GitHub, number: int, branch: str) -> None:
    gh.request("PUT", f"/pulls/{number}/merge", {"merge_method": "merge"})
    gh.request("DELETE", f"/git/refs/heads/{branch}")


def pull_shark(gh: GitHub, args: argparse.Namespace, coauthor: str | None = None) -> None:
    base = gh.default_branch()
    label = "pair" if coauthor else "pull-shark"
    for i in range(1, args.count + 1):
        number, branch = open_pr(gh, base, label, coauthor)
        merge(gh, number, branch)
        print(f"[{i}/{args.count}] merged PR #{number}", flush=True)
        if i < args.count:
            time.sleep(args.delay)


def pair_extraordinaire(gh: GitHub, args: argparse.Namespace) -> None:
    if not (args.coauthor_name and args.coauthor_email):
        raise SystemExit("pair-extraordinaire needs --coauthor-name and --coauthor-email")
    pull_shark(gh, args, coauthor=f"{args.coauthor_name} <{args.coauthor_email}>")


def quickdraw(gh: GitHub, args: argparse.Namespace) -> None:
    issue = gh.request("POST", "/issues", {"title": "Quickdraw", "body": "Opened and closed by a script."})
    gh.request("PATCH", f"/issues/{issue['number']}", {"state": "closed", "state_reason": "completed"})
    print(f"opened and closed issue #{issue['number']}")


def yolo(gh: GitHub, args: argparse.Namespace) -> None:
    if not args.reviewer:
        raise SystemExit("yolo needs --reviewer: a collaborator whose review you skip")
    number, branch = open_pr(gh, gh.default_branch(), "yolo")
    gh.request("POST", f"/pulls/{number}/requested_reviewers", {"reviewers": [args.reviewer]})
    merge(gh, number, branch)
    print(f"merged PR #{number} without waiting for {args.reviewer}'s review")


ACHIEVEMENTS = {
    "pull-shark": pull_shark,
    "pair-extraordinaire": pair_extraordinaire,
    "quickdraw": quickdraw,
    "yolo": yolo,
}


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("achievement", choices=ACHIEVEMENTS)
    parser.add_argument("--repo", required=True, help="owner/name of a sandbox repo")
    parser.add_argument("--count", type=int, default=2, help="PRs to merge (pull-shark, pair-extraordinaire)")
    parser.add_argument("--delay", type=float, default=DEFAULT_DELAY, help="seconds between PRs")
    parser.add_argument("--coauthor-name")
    parser.add_argument("--coauthor-email", help="an email verified on the co-author's GitHub account")
    parser.add_argument("--reviewer", help="collaborator login to request, and then skip, a review from")
    parser.add_argument("--api-url", default=API, help=argparse.SUPPRESS)
    args = parser.parse_args(argv)

    if args.count < 1:
        parser.error("--count must be at least 1")
    if args.repo.split("/")[-1] == "aad-greeks":
        parser.error("refusing to flood aad-greeks with PRs; point --repo at a sandbox")
    token = os.environ.get("ACHIEVEMENTS_TOKEN") or os.environ.get("GITHUB_TOKEN")
    if not token:
        parser.error("set ACHIEVEMENTS_TOKEN to a personal access token")

    try:
        ACHIEVEMENTS[args.achievement](GitHub(token, args.repo, args.api_url), args)
    except HTTPError as err:
        raise SystemExit(str(err)) from None


if __name__ == "__main__":
    main()
