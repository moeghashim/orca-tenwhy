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

def _inject_bloat(workdir: Path) -> None:
    index = workdir / "website" / "index.html"
    html = index.read_text(encoding="utf-8")
    blob = base64.b64encode(b"A" * (4 * 1024 * 1024)).decode("ascii")
    img = f'<img src="data:image/png;base64,{blob}">'
    index.write_text(html.replace("<!-- INJECT_BLOAT -->", img), encoding="utf-8")


def _copy_case(name: str) -> Path:
    src = FIXTURES / name
    dest = Path(tempfile.mkdtemp(prefix=f"tenwhy-web-{name}-"))
    shutil.copytree(src, dest, dirs_exist_ok=True, symlinks=True)
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
    return proc.returncode, checks, workdir


class WebsiteGateTests(unittest.TestCase):
    def _assert_case(self, name: str, exit_code: int, failed_name: str | None) -> list[dict]:
        rc, checks, _workdir = run_case(name)
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

    def test_fail_build_scripts(self):
        rc, checks, workdir = run_case("fail_build_scripts")
        self.assertEqual(rc, 1)
        self.assertFalse(next(c for c in checks if c["check_name"] == "build_ok")["passed"])
        self.assertIn("postinstall", checks[1]["detail"])
        self.assertFalse((workdir / "website" / "PWNED").exists())

    def test_fail_build_config(self):
        self._assert_case("fail_build_config", 1, "build_ok")
        _, checks, _ = run_case("fail_build_config")
        self.assertIn("vite.config.js", checks[1]["detail"])

    def test_fail_build_symlink(self):
        self._assert_case("fail_build_symlink", 1, "build_ok")
        _, checks, workdir = run_case("fail_build_symlink")
        self.assertIn("forbidden", checks[1]["detail"])
        dist = workdir / "website" / "dist"
        if dist.exists():
            for p in dist.rglob("*"):
                self.assertNotIn("/etc", str(p.resolve()))

    def test_fail_build_alias(self):
        self._assert_case("fail_build_alias", 1, "build_ok")
        _, checks, _ = run_case("fail_build_alias")
        self.assertIn("vite", checks[1]["detail"])

    def test_pass_multipage(self):
        rc, checks, workdir = run_case("pass_multipage")
        self.assertTrue(checks[1]["passed"], checks)
        dist = workdir / "website" / "dist"
        htmls = {p.name for p in dist.glob("*.html")}
        self.assertIn("index.html", htmls)
        self.assertIn("contact.html", htmls)
        skip_lh = (
            os.environ.get("WEBSITE_GATE_SKIP_LIGHTHOUSE") == "1"
            and os.environ.get("TENWHY_DEV") == "1"
        )
        if skip_lh:
            self.assertEqual(rc, 0)

    def test_sandbox_denies_home_write_and_network(self):
        sys.path.insert(0, str(GATE.parent))
        from website_gate import NPM_CACHE, gate_env, run_in_sandbox

        tree = Path(tempfile.mkdtemp(prefix="tenwhy-gate-sb-", dir="/private/tmp"))
        home = tree / "home"
        home.mkdir()
        NPM_CACHE.mkdir(parents=True, exist_ok=True)
        env = gate_env(home, NPM_CACHE)
        pwn = Path.home() / "pwned-tenwhy-gate-test"
        if pwn.exists():
            pwn.unlink()
        (tree / "try.mjs").write_text(
            "import fs from 'node:fs';\n"
            f"try {{ fs.writeFileSync({str(pwn)!r}, 'x'); console.log('WROTE'); }}"
            "catch (e) { console.error('WRITE', e.code); }\n"
            "try { const r = await fetch('https://example.com'); console.error('FETCH', r.status); }"
            "catch (e) { console.error('FETCH_ERR', e.cause?.code || e.code || String(e.message)); }\n",
            encoding="utf-8",
        )
        try:
            result = run_in_sandbox(
                "build",
                ["node", "try.mjs"],
                tree=tree,
                cache=NPM_CACHE,
                home=home,
                env=env,
                timeout=30,
            )
            blob = (result.stderr or "") + (result.stdout or "")
            self.assertFalse(pwn.exists(), blob)
            self.assertTrue("EPERM" in blob or "WRITE" in blob, blob)
            self.assertNotIn("FETCH 200", blob)
        finally:
            if pwn.exists():
                pwn.unlink()
            shutil.rmtree(tree, ignore_errors=True)

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
