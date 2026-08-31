#!/usr/bin/env python3
from __future__ import annotations

import json
import sqlite3
import subprocess
import tempfile
import unittest
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
GATE = ROOT / "system" / "gates" / "research_gate.py"
MIGRATE = ROOT / "system" / "db" / "migrate.sh"
FIXTURES = ROOT / "system" / "gates" / "fixtures" / "research"
PYTHON = ROOT / "system" / "tools" / ".venv" / "bin" / "python"

ORDER = [
    "schema_valid",
    "competitors≥5",
    "product_coverage≥25%",
    "enhancement_ideas≥3",
    "sources_complete",
]


def run_case(name: str) -> tuple[int, list[dict]]:
    fixture = FIXTURES / name
    tmp = tempfile.mkdtemp(prefix="tenwhy-gate-")
    db_path = Path(tmp) / "t.db"
    subprocess.check_call(["bash", str(MIGRATE), str(db_path)], cwd=str(ROOT))
    loop_run_id = f"run_{uuid.uuid4().hex[:8]}"
    scrapes = json.loads((fixture / "scrapes.json").read_text(encoding="utf-8"))
    conn = sqlite3.connect(str(db_path))
    try:
        for row in scrapes:
            conn.execute(
                "INSERT INTO scrapes (id, loop_run_id, url, http_status, content_path, created_at) VALUES (?, ?, ?, ?, NULL, datetime('now'))",
                (str(uuid.uuid4()), loop_run_id, row["url"], row.get("http_status")),
            )
        conn.commit()
    finally:
        conn.close()
    proc = subprocess.run(
        [
            str(PYTHON),
            str(GATE),
            "--workdir",
            str(fixture),
            "--db",
            str(db_path),
            "--loop-run-id",
            loop_run_id,
        ],
        cwd=str(ROOT),
        capture_output=True,
        text=True,
    )
    checks = json.loads(proc.stdout.strip().splitlines()[-1])
    return proc.returncode, checks


class ResearchGateTests(unittest.TestCase):
    def _assert_case(self, name: str, exit_code: int, failed_name: str | None) -> None:
        rc, checks = run_case(name)
        self.assertEqual(rc, exit_code, f"{name} exit={rc} stderr={checks}")
        self.assertEqual([c["check_name"] for c in checks], ORDER)
        if failed_name is None:
            self.assertTrue(all(c["passed"] for c in checks), checks)
            return
        self.assertFalse(next(c for c in checks if c["check_name"] == failed_name)["passed"])
        if failed_name == "schema_valid":
            for c in checks[1:]:
                self.assertFalse(c["passed"])
                self.assertEqual(c["detail"], "skipped: schema_valid failed")
            return
        for c in checks:
            if c["check_name"] != failed_name:
                self.assertTrue(c["passed"], f"{name}: {c}")

    def test_pass(self):
        self._assert_case("pass", 0, None)

    def test_fail_schema(self):
        self._assert_case("fail_schema", 1, "schema_valid")

    def test_fail_competitors(self):
        self._assert_case("fail_competitors", 1, "competitors≥5")

    def test_fail_coverage(self):
        self._assert_case("fail_coverage", 1, "product_coverage≥25%")

    def test_fail_ideas(self):
        self._assert_case("fail_ideas", 1, "enhancement_ideas≥3")

    def test_fail_sources(self):
        self._assert_case("fail_sources", 1, "sources_complete")

    def test_fail_competitors_dup(self):
        self._assert_case("fail_competitors_dup", 1, "competitors≥5")

    def test_fail_fabricated_nested_url(self):
        self._assert_case("fail_fabricated_nested_url", 1, "competitors≥5")

    def test_fail_coverage_unknown_id(self):
        self._assert_case("fail_coverage_unknown_id", 1, "product_coverage≥25%")
        _, checks = run_case("fail_coverage_unknown_id")
        cov = next(c for c in checks if c["check_name"] == "product_coverage≥25%")
        self.assertIn("0/2", cov["detail"])
        self.assertIn("unknown customer_product_id", cov["detail"])


if __name__ == "__main__":
    unittest.main()
