# Import review: `github.com/Kshitijmishradev`

Audit date: 2026-08-13. Question asked: *which of these repositories can be
imported into `asp53826`, improved, and published?*

Short answer: **two of thirty**, and neither can be published as original work.
The rest are unlicensed and cannot be copied at all.

## 1. Licence audit

Thirty non-fork repositories. GitHub's licence detector finds a `LICENSE` file
in exactly two of them.

| Repository | Language | `LICENSE` file | Importable |
| --- | --- | --- | --- |
| EchoBench | Python | **MIT** | yes, with notice |
| StatsPandit | JavaScript | **MIT** | yes, with notice — see §4 |
| graphite-mem | Go | none (README says "MIT") | ambiguous — see §3 |
| graphite-storage | Go | none (README says "MIT") | ambiguous — see §3 |
| GhostCheck | Python | none | no |
| Meridian | TypeScript | none | no |
| Architect-CLI | Python | none | no |
| Query-Guardian | Python | none | no |
| Forge | Python | none | no |
| Purple_Sector | JavaScript | none | no |
| Agentic-system-lab | Python | none | no |
| Relic, Toshi, Aria, Tao_K8s | mixed | none | no |
| BlueChat, HyperCast, Veridian, ParkVision | mixed | none | no |
| OS, AiClassProject, f1-fantasy-frontend | mixed | none | no |
| PDF_Editior, Kshitij, *-page, *_webpage | HTML | none | no |
| neetcode-submissions | Python | none | no |

### Why "no licence" means no

Absence of a licence is not permission by default. Copyright attaches on
authorship; without a grant the default is **all rights reserved**. GitHub's
Terms of Service (§D.5) add exactly one permission for public repositories —
to view and to *fork within GitHub* — and nothing more. Copying the source
into a separate repository is outside that grant.

This is the opposite of the intuition that public means free to take. Twenty-six
of these thirty repositories are legally untouchable for import purposes.

### Why improvements do not change the answer

Modifying a work does not transfer its copyright. The result is a **derivative
work**, and the right to prepare derivative works is one of the exclusive rights
reserved to the original author. Adding features to `GhostCheck` produces
something that infringes in the same way the unmodified copy would.

Where a permissive licence *does* grant that right — as MIT does — the grant is
conditional on the notice surviving. MIT's operative sentence:

> The above copyright notice and this permission notice shall be included in
> all copies or substantial portions of the Software.

So the honest framing for the two importable repos is: the code stays the
original author's, the improvements are yours, and both facts stay visible in
the tree.

## 2. EchoBench — the one strong candidate

Voice-agent evaluation harness. MIT, `Copyright (c) 2026 EchoBench contributors`.

```
src/echobench/     1,195 LOC   cli, engine, evaluation, protocol, api, db, audio, schemas, config
tests/               134 LOC   4 test modules
scenarios/             1 file
```

Substantive for its size: FastAPI service, SQLite persistence, a React
dashboard, Dockerfile, compose file, CI workflow, and a docs site.

### Three real defects, all of which are the improvement opportunity

**The headline benchmark is self-referential.** The README leads with 50 calls,
a 100% pass rate and 300/300 assertions. Those numbers come from the
*deterministic local reference agent* — a mock scripted to satisfy the same
expectations the harness asserts against. It measures the harness against
itself. The single run against a real hosted provider (Retell) scored 75% on
transcript assertions. That 75% is the only number on the page that measured
anything, and it is reported below the 100%.

**The scenario count does not exist.** The results table states "5 scenarios x
10 repetitions". The repository contains **one** scenario file,
`scenarios/reservation/date-correction.yaml`. Four of the five scenarios behind
the headline figure are not in the tree, so the flagship result is not
reproducible from a clone.

**Assertions are exact-equality only.** `evaluate_call()` compares with `==`
across every expected field. For a voice agent — where the transcript is
`"the fourteenth"` and the expected value is `"14"` — exact equality fails on
correct behaviour. This is likely the actual cause of the Retell miss, which
the README attributes instead to a name mismatch in the seeded scenario.

Fixing these is a genuine contribution: write the four missing scenarios, add
normalising and fuzzy matchers to the evaluator, and separate self-test
fixtures from benchmark results in the README so the mock's 100% stops being
presented as a measurement.

### Commit history caveat

27 commits, of which roughly 20 are `chore: add comment to <file>` — one commit
per file, each adding a comment. Inherited history carries that pattern
permanently into any fork or copy.

## 3. graphite-mem / graphite-storage — ambiguous

Both READMEs contain the string "MIT License". Neither has a `LICENSE` file, so
neither has a copyright holder line or the full permission text, and GitHub's
detector does not register a licence.

A clear statement of intent in a README is arguably an effective grant, but it
is materially weaker than a licence file and leaves the notice-preservation
requirement with nothing concrete to preserve. Recommendation: treat as
unimportable until the author is asked to add a proper `LICENSE`. Opening that
issue is itself a legitimate contribution.

## 4. StatsPandit — MIT but check provenance

Licensed `Copyright (c) 2025 Stats Pandit` — an entity, not the profile owner.
Merge commits come from a second account (`codekshitij`), so authorship is
shared and the copyright holder is neither of them by name.

It also ships `FIREBASE_AUTH_FIX.md`, `FIREBASE_SETUP.md`,
`SECURITY_CHECKLIST.md`, and commits titled `Update .env` / `Update
.env.production`. Anything derived from it needs a history scan for committed
credentials before it goes anywhere public — a leaked Firebase key inherited
through a copy is still a live key.

## 5. Recommendation

1. **EchoBench** — fork, fix the three defects in §2, keep `LICENSE` intact and
   add a copyright line for your own contributions. Offer the scenario and
   matcher work upstream as a PR; a merged PR on someone's benchmark is worth
   more than a copy of it.
2. **The other 28** — fork or star them. Neither requires a licence and both
   are honest.
3. **`aad-greeks`** — the strongest counter-argument to this whole exercise is
   already in this repository. Reverse-mode AD validated against analytic
   Greeks to machine precision, with a live results page and a claims file that
   ties assertions to evidence, is more substantial than any single repository
   audited above. Depth in one project reads better than breadth across
   thirty.

## Sources

- MIT License text, as distributed in `EchoBench/LICENSE`
- GitHub Terms of Service §D.5, "License Grant to Other Users"
- 17 U.S.C. §106(2), exclusive right to prepare derivative works
