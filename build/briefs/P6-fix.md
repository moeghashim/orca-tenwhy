# Follow-up brief — Phase 6 fidelity + review fixes (commits `P6-fix: …`, each with a jsdom test where testable)

Source: orchestrator visual comparison of the seeded build vs `dashboard/design/Loop Graph.dc.html` (headless Chrome, 1440 px, 2026-08-30) + Codex `REVIEWED: P6 … #r1` (appended when it lands). Design files win on appearance — match the mock exactly for each item below.

1. **Sidebar wordmark** — mock: one mono line `tenwhy / loop graph` with the sans subtitle `operations console` beneath. Build shows `tenwhy /` wrapped onto two lines with subtitle `loop graph`. Fix text + no-wrap.
2. **Connection card** — mock: `● live` (green, mono) on the first line and `SSE /api/events` (muted, small) beneath — two lines total. Build wraps `live · SSE /api/events` and repeats `/api/events` a third time. Render exactly two lines; `reconnecting · retry n/5 in Ns` and `disconnected` + close time follow the same two-line pattern.
3. **Runs header summary** — mock: `Runs` followed by the muted line `8 engagements · 5 active · sorted by last event`. Build omits it. Add `${engagements.length} engagements · ${active} active · sorted by last event` (active = engagements with a `running`/`queued` loop run).
4. **needs_human banner** — mock: text `⚑ N runs need human input` + `every other loop is proceeding without you` on the left, `open failures →` pinned to the **right edge**. Build places the link inline. Flex with `justify-content: space-between`.
5. **Sidebar footer snapshot time** — mock: `snapshot 12:41:03 · v0.1.0`. Build shows `snapshot now`. Render the snapshot's `serverTime` as `HH:MM:SS` (server value, not the client clock; update on every snapshot refetch).
6. **Iteration header spacing** — `iteration 1 ✓ approve 7m ago` renders with the verdict badge touching the label. Match the mock: label, badge, and relative time separated by an 8 px gap.
7. **Seed realism** — `seed.mjs`: the `awaiting_approval` engagement's research run (`run_res_0143`) has no `gate_checks` rows, so the loop detail shows `0/0 passed`; seed the five research checks as passed for a `gate_passed` run, and give the `complete` engagement a website run with five passed checks so the pipeline strip and gate card look like the mock.

Finish with `DONE P6-fix <hash…>` — only hashes in `git log`.
