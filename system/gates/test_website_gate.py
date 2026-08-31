#!/usr/bin/env python3
from __future__ import annotations

import base64
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
GATE = ROOT / "system" / "gates" / "website_gate.py"
MIGRATE = ROOT / "system" / "db" / "migrate.sh"
FIXTURES = ROOT / "system" / "gates" / "fixtures" / "website"
PYTHON = ROOT / "system" / "tools" / ".venv" / "bin" / "python"

ORDER = [
    "brand_assets_valid",
    "build_ok",
    "links_ok",
    "copy_grounded",
    "lighthouse≥85",
]

_NODE_CACHE: Path | None = None


def _node_modules() -> Path:
    global _NODE_CACHE
    if _NODE_CACHE is not None:
        return _NODE_CACHE
    src = FIXTURES / "pass" / "website" / "package.json"
    dest = Path(tempfile.mkdtemp(prefix="tenwhy-vite-nm-"))
    shutil.copy(src, dest / "package.json")
    env = {
        **os.environ,
        "npm_config_audit": "false",
        "npm_config_fund": "false",
        "npm_config_progress": "false",
        "npm_config_update_notifier": "false",
    }
    subprocess.check_call(["npm", "install"], cwd=dest, env=env, timeout=180)
    _NODE_CACHE = dest
    return dest


def _inject_bloat(workdir: Path) -> None:
    index = workdir / "website" / "index.html"
    html = index.read_text(encoding="utf-8")
    blob = base64.b64encode(b"A" * (4 * 1024 * 1024)).decode("ascii")
    img = f'<img src="data:image/png;base64,{blob}">'
    index.write_text(html.replace("<!-- INJECT_BLOAT -->", img), encoding="utf-8")


def _copy_case(name: str) -> Path:
    src = FIXTURES / name
    dest = Path(tempfile.mkdtemp(prefix=f"tenwhy-web-{name}-"))
    shutil.copytree(src, dest, dirs_exist_ok=True)
    web = dest / "website"
    nm = web / "node_modules"
    if nm.exists() or nm.is_symlink():
        if nm.is_symlink() or not nm.is_dir():
            nm.unlink()
        else:
            shutil.rmtree(nm)
    os.symlink(_node_modules() / "node_modules", nm)
    if name == "fail_lighthouse":
        _inject_bloat(dest)
    return dest


def run_case(name: str) -> tuple[int, list[dict]]:
    workdir = _copy_case(name)
    tmp = tempfile.mkdtemp(prefix="tenwhy-webgate-")
    db_path = Path(tmp) / "t.db"
    subprocess.check_call(["bash", str(MIGRATE), str(db_path)], cwd=str(ROOT))
    loop_run_id = f"run_{uuid.uuid4().hex[:8]}"
    proc = subprocess.run(
        [
            str(PYTHON),
            str(GATE),
            "--workdir",
            str(workdir),
            "--db",
            str(db_path),
            "--loop-run-id",
            loop_run_id,
        ],
        cwd=str(ROOT),
        capture_output=True,
        text=True,
    )
    if not proc.stdout.strip():
        raise AssertionError(f"{name} produced no stdout exit={proc.returncode} stderr={proc.stderr}")
    checks = json.loads(proc.stdout.strip().splitlines()[-1])
    return proc.returncode, checks


class WebsiteGateTests(unittest.TestCase):
    def _assert_case(self, name: str, exit_code: int, failed_name: str | None) -> list[dict]:
        rc, checks = run_case(name)
        self.assertEqual([c["check_name"] for c in checks], ORDER, checks)
        self.assertEqual(rc, exit_code, f"{name} exit={rc} checks={checks} ")
        if failed_name is None:
            self.assertTrue(all(c["passed"] for c in checks), checks)
            return checks
        self.assertFalse(next(c for c in checks if c["check_name"] == failed_name)["passed"], checks)
        if failed_name == "build_ok":
            for c in checks[2:]:
                self.assertFalse(c["passed"], c)
                self.assertEqual(c["detail"], "skipped: build_ok failed")
            return checks
        skip_lh = (
            os.environ.get("WEBSITE_GATE_SKIP_LIGHTHOUSE") == "1"
            and os.environ.get("TENWHY_DEV") == "1"
        )
        for c in checks:
            if c["check_name"] == failed_name:
                continue
            if skip_lh and c["check_name"] == "lighthouse≥85":
                self.assertTrue(c["passed"], c)
                continue
            self.assertTrue(c["passed"], f"{name}: {c}")
        return checks

    def test_pass(self):
        checks = self._assert_case("pass", 0, None)
        skip_lh = (
            os.environ.get("WEBSITE_GATE_SKIP_LIGHTHOUSE") == "1"
            and os.environ.get("TENWHY_DEV") == "1"
        )
        if not skip_lh:
            self.assertRegex(checks[-1]["detail"], r"performance=\d+ accessibility=\d+")

    def test_fail_brand(self):
        self._assert_case("fail_brand", 1, "brand_assets_valid")

    def test_fail_build(self):
        self._assert_case("fail_build", 1, "build_ok")

    def test_fail_links(self):
        checks = self._assert_case("fail_links", 1, "links_ok")
        self.assertIn("broken links", checks[2]["detail"])

    def test_fail_placeholders(self):
        checks = self._assert_case("fail_placeholders", 1, "links_ok")
        self.assertIn("unwired placeholders", checks[2]["detail"])
        self.assertIn("/images/unwired.svg", checks[2]["detail"])

    def test_fail_copy(self):
        self._assert_case("fail_copy", 1, "copy_grounded")

    def test_lighthouse_skip_requires_tenwhy_dev(self):
        sys.path.insert(0, str(GATE.parent))
        from website_gate import lighthouse_skip_honoured  # noqa: E402

        prev_skip = os.environ.get("WEBSITE_GATE_SKIP_LIGHTHOUSE")
        prev_dev = os.environ.get("TENWHY_DEV")
        try:
            os.environ["WEBSITE_GATE_SKIP_LIGHTHOUSE"] = "1"
            os.environ.pop("TENWHY_DEV", None)
            self.assertFalse(lighthouse_skip_honoured())
            os.environ["TENWHY_DEV"] = "1"
            self.assertTrue(lighthouse_skip_honoured())
            os.environ.pop("WEBSITE_GATE_SKIP_LIGHTHOUSE", None)
            self.assertFalse(lighthouse_skip_honoured())
        finally:
            if prev_skip is None:
                os.environ.pop("WEBSITE_GATE_SKIP_LIGHTHOUSE", None)
            else:
                os.environ["WEBSITE_GATE_SKIP_LIGHTHOUSE"] = prev_skip
            if prev_dev is None:
                os.environ.pop("TENWHY_DEV", None)
            else:
                os.environ["TENWHY_DEV"] = prev_dev

    @unittest.skipIf(
        os.environ.get("WEBSITE_GATE_SKIP_LIGHTHOUSE") == "1" and os.environ.get("TENWHY_DEV") == "1",
        "lighthouse skipped",
    )
    def test_fail_lighthouse(self):
        checks = self._assert_case("fail_lighthouse", 1, "lighthouse≥85")
        self.assertRegex(checks[-1]["detail"], r"performance=\d+ accessibility=\d+")


if __name__ == "__main__":
    unittest.main()
