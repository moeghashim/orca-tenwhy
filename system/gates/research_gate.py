#!/usr/bin/env python3
"""Company-research exit gate. jsonschema 4.26.0 (venv)."""
from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from pathlib import Path

import jsonschema

ROOT = Path(__file__).resolve().parent.parent.parent
SCHEMA_PATH = Path(__file__).resolve().parent / "research_schema.json"
SKIP = "skipped: schema_valid failed"
CHECK_NAMES = [
    "schema_valid",
    "competitors≥5",
    "product_coverage≥25%",
    "enhancement_ideas≥3",
    "sources_complete",
]


def check(name: str, passed: bool, detail: str) -> dict:
    return {"check_name": name, "passed": bool(passed), "detail": detail}


def load_schema() -> dict:
    return json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))


def urls_200(conn: sqlite3.Connection, loop_run_id: str) -> set[str]:
    rows = conn.execute(
        "SELECT url FROM scrapes WHERE loop_run_id = ? AND http_status = 200",
        (loop_run_id,),
    ).fetchall()
    return {r[0] for r in rows}


def scrape_status_label(http_status) -> str:
    if http_status is None:
        return "refused"
    return str(http_status)


def scrape_row_counts(conn: sqlite3.Connection, loop_run_id: str) -> dict[tuple[str, str], int]:
    rows = conn.execute(
        "SELECT url, http_status FROM scrapes WHERE loop_run_id = ?",
        (loop_run_id,),
    ).fetchall()
    counts: dict[tuple[str, str], int] = {}
    for url, status in rows:
        key = (url, scrape_status_label(status))
        counts[key] = counts.get(key, 0) + 1
    return counts


def parse_source_rows(text: str) -> dict[tuple[str, str], int]:
    counts: dict[tuple[str, str], int] = {}
    for raw in text.splitlines():
        line = raw.strip()
        if not line.startswith("|"):
            continue
        cells = [c.strip() for c in line.strip("|").split("|")]
        if len(cells) < 2:
            continue
        url, status = cells[0], cells[1]
        if not url or url.lower() == "url" or set(url) <= {"-", ":"}:
            continue
        if set(status) <= {"-", ":"}:
            continue
        key = (url, status)
        counts[key] = counts.get(key, 0) + 1
    return counts


def is_number(value) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def run_checks(workdir: Path, db_path: Path, loop_run_id: str) -> list[dict]:
    research_path = workdir / "research" / "RESEARCH.json"
    sources_path = workdir / "research" / "SOURCES.md"
    conn = sqlite3.connect(str(db_path))
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        if not research_path.is_file():
            reason = f"missing {research_path}"
            return [
                check("schema_valid", False, reason),
                *[check(n, False, SKIP) for n in CHECK_NAMES[1:]],
            ]
        try:
            data = json.loads(research_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            return [
                check("schema_valid", False, f"unparsable RESEARCH.json: {exc}"),
                *[check(n, False, SKIP) for n in CHECK_NAMES[1:]],
            ]
        try:
            jsonschema.validate(instance=data, schema=load_schema())
        except jsonschema.ValidationError as exc:
            return [
                check("schema_valid", False, exc.message),
                *[check(n, False, SKIP) for n in CHECK_NAMES[1:]],
            ]
        schema_ok = check("schema_valid", True, "ok")
        ok_urls = urls_200(conn, loop_run_id)
        competitors = data.get("competitors") or []
        failing = []
        for c in competitors:
            url = c.get("url") or ""
            if url not in ok_urls:
                failing.append(c.get("name") or url or "(unnamed)")
        comp_ok = len(competitors) >= 5 and not failing
        if len(competitors) < 5:
            comp_detail = f"{len(competitors)} competitors (need ≥ 5)"
        elif failing:
            comp_detail = "no 200 scrape: " + ", ".join(failing)
        else:
            comp_detail = f"{len(competitors)} competitors with 200 scrapes"
        products = (data.get("company") or {}).get("customer_products") or []
        matches = data.get("product_matches") or []
        total = len(products)
        distinct = set()
        offending = []
        for m in matches:
            src = m.get("source_url") or ""
            price = m.get("competitor_price")
            pid = m.get("customer_product_id")
            if not is_number(price) or src not in ok_urls:
                offending.append(f"{pid}@{src or '(no source)'}")
                continue
            if pid:
                distinct.add(pid)
        ratio = (len(distinct) / total) if total else 0.0
        cov_ok = total > 0 and ratio >= 0.25 and not offending
        cov_detail = f"{len(distinct)}/{total}"
        if offending:
            cov_detail += "; offending: " + ", ".join(offending)
        ideas = data.get("enhancement_ideas") or []
        good_ideas = [
            i
            for i in ideas
            if str(i.get("idea") or "").strip() and str(i.get("rationale") or "").strip()
        ]
        ideas_ok = len(good_ideas) >= 3
        ideas_detail = f"{len(good_ideas)} ideas with rationale"
        sources_text = sources_path.read_text(encoding="utf-8") if sources_path.is_file() else ""
        source_counts = parse_source_rows(sources_text)
        scrape_counts = scrape_row_counts(conn, loop_run_id)
        missing = []
        for key, need in scrape_counts.items():
            have = source_counts.get(key, 0)
            if have < need:
                missing.append(f"{key[0]}|{key[1]} x{need - have}")
        src_ok = not missing
        src_detail = "ok" if src_ok else "missing: " + ", ".join(missing)
        return [
            schema_ok,
            check("competitors≥5", comp_ok, comp_detail),
            check("product_coverage≥25%", cov_ok, cov_detail),
            check("enhancement_ideas≥3", ideas_ok, ideas_detail),
            check("sources_complete", src_ok, src_detail),
        ]
    finally:
        conn.close()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="research_gate.py")
    parser.add_argument("--workdir", required=True)
    parser.add_argument("--db", required=True)
    parser.add_argument("--loop-run-id", required=True)
    args = parser.parse_args(argv)
    checks = run_checks(Path(args.workdir), Path(args.db), args.loop_run_id)
    print(json.dumps(checks, ensure_ascii=False))
    return 0 if checks and all(c["passed"] for c in checks) else 1


if __name__ == "__main__":
    sys.exit(main())
