# Achievement unlocker

A bounded, rate-limit-aware take on
[XTUFE/GitHub-Achievement-Unlocker](https://github.com/XTUFE/GitHub-Achievement-Unlocker).
It earns profile achievements by creating real activity (branches, PRs, merges,
issues) through the GitHub REST API. It uses only the standard library.

**Always point it at a throwaway sandbox repo.** Every run leaves merged PRs in
the target's history. The script refuses to target `aad-greeks`.

| Achievement | What the script does | Tiers |
|---|---|---|
| `pull-shark` | opens and merges `--count` PRs | 2 / 16 / 128 / 1024 merged PRs |
| `pair-extraordinaire` | same, each commit `Co-authored-by` someone else | 1 / 10 / 24 / 48 |
| `quickdraw` | opens an issue and closes it at once | 1 |
| `yolo` | requests a review, then merges without it | 1 |

Each run changes one file, `ACHIEVEMENTS.md`, in the sandbox, deletes its
branches after merging, and marks commits `[skip ci]`.

## One-time setup

1. **Create a sandbox repo**, e.g. `achievement-sandbox`, and initialise it
   with a README so it has a default branch. Public repos are safest:
   achievements from private activity only count if your profile shows private
   contributions.
2. **Create a fine-grained personal access token** at
   GitHub → Settings → Developer settings → Fine-grained tokens. Limit it to the
   sandbox repo with *Contents*, *Pull requests* and *Issues* set to
   **Read and write**. Don't give it access to anything else.
3. For `pair-extraordinaire`: you need a co-author with a real GitHub account.
   The email you pass must be verified on their account (their
   `id+login@users.noreply.github.com` address works). For `yolo`: invite a
   second account as a collaborator on the sandbox and accept the invite.

## Run it from GitHub (no computer needed)

1. In **aad-greeks** → Settings → Secrets and variables → Actions, add a
   secret named `ACHIEVEMENTS_TOKEN` holding the token.
2. Actions → **Achievements** → *Run workflow*, then pick the achievement and
   enter the sandbox as `owner/name`.

The workflow is manual-only and only shows up once this file is on `main`.

## Run it locally

```sh
export ACHIEVEMENTS_TOKEN=github_pat_...
python tools/achievements/unlock.py pull-shark --repo asp53826/achievement-sandbox --count 16
python tools/achievements/unlock.py quickdraw --repo asp53826/achievement-sandbox
python tools/achievements/unlock.py pair-extraordinaire --repo asp53826/achievement-sandbox \
    --count 10 --coauthor-name FRIEND --coauthor-email FRIEND_VERIFIED_EMAIL
python tools/achievements/unlock.py yolo --repo asp53826/achievement-sandbox --reviewer FRIEND
```

## Pace and limits

- GitHub caps content-creating API calls at about 500 an hour. A PR cycle
  makes four of them, so the default `--delay 30` comes to roughly 100 PRs an
  hour. Go faster and GitHub starts rejecting requests. The script waits that
  out instead of crashing.
- That puts gold Pull Shark (1024) at about 10 hours. An Actions job stops
  after 6 hours, so split it into runs of ~500 or run it locally.
- Badges usually appear within a few minutes, sometimes a few hours.
- Scripted activity isn't something GitHub encourages, and its Acceptable Use
  Policies forbid inauthentic activity and spam. Keep it to your own sandbox
  and don't involve other people's repositories or accounts without their
  consent.
