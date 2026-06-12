---
product: fractal
date: 2026-06-03
iteration: 1
result: PASS
---

# Design Review Report (Iteration 1)

## Summary

| # | Criterion | Group | Score | Threshold | Status |
|---|---|---|---|---|---|
| N01 | Section Completeness | completeness | 10 | 8 | PASS |
| N02 | ADR Traceability | completeness | 9 | 8 | PASS |
| N03 | Ambiguity | clarity | 9 | 8 | PASS |
| N04 | Numeric Provenance | clarity | 9 | 8 | PASS |
| N05 | Cross-Section Consistency | architecture | 10 | 8 | PASS |
| N06 | Diagram Coverage | architecture | 10 | 8 | PASS |
| N07 | Information Density | clarity | 9 | 7 | PASS |
| N08 | YAGNI | robustness | 10 | 7 | PASS |
| N09 | Adversarial Resilience | robustness | 8 | 7 | PASS |
| N10 | Banned Terms | quality | 9 | 8 | PASS |

**Result: PASS**

---

## Findings

### N01: Section Completeness (Score: 10)

- 21 top-level sections (§0–§20) all present with substantive content
- 0 `(to fill)` placeholders remaining
- 16 `(N/A — reason)` entries, all with justification (system is a local VS Code extension, so AWS/infra sections correctly marked N/A)
- §20 has 6 sub-sections (§20.1–§20.6 + §20.x Accessibility) with exhaustive tabular content

No issues found.

---

### N02: ADR Traceability (Score: 9)

- 11 ADR references found in design.md
- 3 ADRs exist with scope `fractal` (ADR-001, ADR-002, ADR-003); all 3 are referenced
- ADR-004, ADR-005 correctly excluded (other product scope)
- Appendix A present and complete with section cross-references
- Key decisions cite ADRs: Three Provider Architecture (§3.1, §3.3), S3 Sync via CLI (§6.7), HtmlMdConverter monorepo (§6.6)

Minor: §13.2 references the data-loss invariant but could explicitly cite `(ADR-002)` for the `--delete` prohibition. Not material since §1.3 already has the citation.

---

### N03: Ambiguity (Score: 9)

Scanned for ambiguous terms. Results:
- "通常" appears 7 times — all in table rows as UI state labels (e.g., "通常編集", "通常ファイル", "通常クリック") meaning "normal state" as a concrete UI mode name, not a vague qualifier. Acceptable.
- No TBD/TODO/未定/要決 markers found
- No subjective qualifiers ("fast", "robust", "scalable") in NFR or SLA sections
- All NFR values in §1.6 are concrete numbers with measurement methods
- No "必要に応じて", "適宜", "いくつか" found

No actionable issues.

---

### N04: Numeric Provenance (Score: 9)

Numbers found and their provenance:

| Number | Location | Source cited |
|---|---|---|
| 50MB file size limit | §1.6, §10.5 | `outliner.js:1007` |
| 200 undo snapshots | §1.6, §7.1, §10.5 | `MAX_UNDO=200, MAX_STACK=200` |
| 500 files/batch | §1.6, §6.7, §10.5 | `BATCH_SIZE=500` |
| ~10,000 files scale | §1.6, §10.5 | AWS CLI internal parallelism |
| 1000ms sync debounce | §1.6, §4.3 | code constant |
| 1500ms idle timeout | §1.6, §4.6 | code constant |
| 500ms typing debounce | §1.6 | code constant |
| 10KB translate chunk | §6.8, §10.5 | `MAX_BYTES_PER_REQUEST=10000` |
| 50 nav history | §7.1, §10.5 | `MAX_NAV_HISTORY=50` |
| 200ms debounce (drawio) | §6.10 | code |
| 140px panel min width | §20.5 | `PANEL_MIN_WIDTH` |
| 0.2x–16x zoom range | §20.4 | code |
| ~178 spec files | §2.7 | `test/specs/` count |

All concrete numbers have code-level sourcing. No unsourced arbitrary values.

---

### N05: Cross-Section Consistency (Score: 10)

Cross-checked:
- §3.1 component diagram lists same components as §6 (all 11 components match)
- §5.4 Node schema agrees with §2.4 classification axis #6 (mutually exclusive types)
- §7.1 state lists agree with §4.5 (same variables)
- §10.5 capacity numbers match §1.6 NFR table
- §11.3 pipeline matches package.json scripts
- §20 keyboard/mouse tables reference §6 component IDs consistently

No contradictions found. Technical choices are uniform across all sections.

---

### N06: Diagram Coverage (Score: 10)

9 mermaid diagrams found:

| Diagram | Section | Type |
|---|---|---|
| Component placement | §3.1 | `graph TB` |
| DFD L0 | §8.2 | `graph LR` |
| Pipeline | §11.3 | `graph LR` |
| UNIT dependency DAG | §3.7 | `graph LR` |
| ER diagram | §5.3 | `erDiagram` |
| Editing sequence | §4.3 Flow 1 | `sequenceDiagram` |
| External Change Sync sequence | §4.3 Flow 2 | `sequenceDiagram` |
| D&D import sequence | §4.3 Flow 3 | `sequenceDiagram` |
| Run lifecycle | §4.6 | `stateDiagram-v2` |

All mandatory diagrams present (§3 component, §4 sequence/state, §8 DFD L0) plus 6 additional. Diagrams are consistent with prose.

---

### N07: Information Density (Score: 9)

- No filler phrases detected ("It should be noted", "なお、", "In order to", etc.)
- Content is tabular where appropriate (reducing verbose prose)
- §20 sections use compact table format for exhaustive inventories
- Provenance comments `(derived from code)` / `(asked YYYY-MM-DD)` are concise

Minor observation: Some `(asked 2026-06-02; user confirmed)` provenance lines could be removed from the final document since they are session metadata rather than design content. However, they serve as audit trail per the skill protocol, so acceptable.

---

### N08: YAGNI (Score: 10)

- All described features exist in the current codebase (GA product)
- No "future extensibility" abstractions designed beyond current needs
- §18 correctly captures future work as explicitly out-of-scope
- No plugin architecture or factory patterns beyond what code actually implements
- §12 AI is properly `(N/A)` rather than designing speculative AI integration

No over-engineering found. This is a reverse-engineered design doc of an existing product.

---

### N09: Adversarial Resilience (Score: 8)

Applicable scenarios for a local VS Code extension:

| Scenario | Addressed? | Location |
|---|---|---|
| Path traversal (malicious input) | ✅ | §9.4 STRIDE + §13.2 (`safeResolveUnderDir`) |
| webview accessing arbitrary files | ✅ | §9.4 (`localResourceRoots` + CSP) |
| Data loss from concurrent writes | ✅ | §7.4 (single writer per store, TextDocument exclusion) |
| Large file DoS (memory exhaustion) | ✅ | §10.5 (50MB guard), §10.6 (bottleneck acknowledged) |
| S3 credential exposure | ✅ | §9.5 (no secrets in extension, user-managed CLI profiles) |
| AWS service unavailable | Partial | §4.4 (AWS CLI internal retry) — no explicit fallback/degraded mode |
| Race condition (multiple .out edits) | ✅ | §7.4 (TextDocument 排他) |

"AWS service unavailable" scenario only has "AWS CLI 内部のリトライに委任" — could benefit from noting user-visible behavior (error message, retry button state). Minor gap.

---

### N10: Banned Terms (Score: 9)

CONTEXT.md Avoid list checked:

| Banned term | Found in body? | Context | Verdict |
|---|---|---|---|
| "Page Editor" | ❌ | — | OK |
| "AI sync" | ❌ | — | OK |
| "real-time collaboration" | ❌ | — | OK |
| "turndown" | ✅ (6 places) | npm package name in tech stack/dependency tables | **Acceptable** — refers to the literal library, not the concept |
| "paste converter" | ❌ | — | OK |
| "note.json" | ❌ | — | OK |
| "manifest" | ✅ (1 place) | §15.1 migration table: "Note manifest" as the OLD format name | **Acceptable** — describing the legacy term being migrated FROM |

Appendix B is present and complete, matching CONTEXT.md exactly.

Minor: §15.1 uses "Note manifest" as a column value for the legacy format. This is technically using a banned term but in a migration context describing what is being renamed away from. Acceptable.

---

## Observations (non-scoring)

1. **Strengths**: Exhaustive §20 keyboard/mouse/DnD inventory (200+ interaction rows), clear 4-mode coverage mandate, strong data model documentation with concrete JSON examples, excellent use of classification axis tables.

2. **This is a local VS Code extension** — many enterprise-focused criteria (IAM, DLQ, circuit breakers, multi-AZ) are correctly N/A. The scoring acknowledges this context.

3. **designer_failures.md patterns checked**: No applicable patterns found (all recorded failures relate to multi-service backend systems, not VS Code extensions).
