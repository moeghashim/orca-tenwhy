# Follow-up brief — Phase 6 round 2 (Codex `REVIEWED: P6 issues #r2`, 2026-08-30) — commits `P6-fix2: …`, each with a jsdom test

1. **In-place patching everywhere** (`dashboard/web/src/app.js:171`, `:605`): Runs must patch **cells** in place (keep the cell nodes; update `textContent`/attributes only), and Loop detail, Failures and Customers must patch their existing nodes by entity id instead of replacing the root. Test: capture references to a Runs cell node, a Failures card node, a Customers card node and a Loop-detail gate row; apply patches; assert `isSameNode` for each and updated text.
2. **Flash restore** (`app.js:217`): when the 800 ms timer clears a row's flash id, the render path must remove the inline background (or the flash class) so the row returns to its normal background. Test with fake timers: after the timer, `row.style.background === ""` (or the class is absent) and `getComputedStyle`/class checks show no flash.
3. **Runs re-sort on reconnect** (`app.js:214`): on reconnect (snapshot refetch) the Runs table must physically reorder its row nodes to the new `engagementOrder` (move nodes, don't rebuild). Test: connected patch changes a row's last-event → order unchanged; `reconnect()` → rows reordered by the new order, same node identities.

Finish with `DONE P6-fix2 <hash…>` — only hashes in `git log`.
