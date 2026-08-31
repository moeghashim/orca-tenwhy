#!/usr/bin/env python3
from __future__ import annotations

import base64
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
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

    def test_fail_build_artifact_symlink(self):
        sys.path.insert(0, str(GATE.parent))
        from website_gate import copy_dist_out

        tmp = Path(tempfile.mkdtemp())
        src = tmp / "dist"
        src.mkdir()
        (src / "index.html").write_text("<html></html>", encoding="utf-8")
        (src / "public").mkdir()
        outside = tmp / "secret"
        outside.write_text("pwn", encoding="utf-8")
        (src / "public" / "etc").symlink_to(outside)
        dest = tmp / "out"
        detail = copy_dist_out(src, dest)
        self.assertIsNotNone(detail)
        self.assertIn("unsafe artifact:", detail)
        shutil.rmtree(tmp)

    def test_tampered_vite_tarball_fails_integrity(self):
        sys.path.insert(0, str(GATE.parent))
        from website_gate import sha512_sri, verify_vite_tarball

        tmp = Path(tempfile.mkdtemp())
        tarball = tmp / "vite-6.4.3.tgz"
        tarball.write_bytes(b"vite-tarball-bytes")
        expected = sha512_sri(tarball)
        self.assertIsNone(verify_vite_tarball(tarball, expected))
        tarball.write_bytes(b"vite-tarball-bytes!")
        self.assertEqual(verify_vite_tarball(tarball, expected), "vite integrity mismatch")
        shutil.rmtree(tmp)

    def test_wrong_vite_version_in_node_modules_fails(self):
        sys.path.insert(0, str(GATE.parent))
        from website_gate import assert_vite_installed

        tmp = Path(tempfile.mkdtemp())
        pkg = tmp / "node_modules" / "vite" / "package.json"
        pkg.parent.mkdir(parents=True)
        pkg.write_text(json.dumps({"name": "vite", "version": "0.0.1"}), encoding="utf-8")
        self.assertIn("vite version mismatch", assert_vite_installed(tmp, "6.4.3") or "")
        pkg.write_text(json.dumps({"name": "vite", "version": "6.4.3"}), encoding="utf-8")
        self.assertIsNone(assert_vite_installed(tmp, "6.4.3"))
        shutil.rmtree(tmp)

    def test_sandbox_denies_home_write_and_network(self):
        sys.path.insert(0, str(GATE.parent))
        from website_gate import NPM_CACHE, gate_env, run_in_sandbox

        tree = Path(tempfile.mkdtemp(prefix="tenwhy-gate-sb-", dir="/private/tmp"))
        home = tree / "home"
        home.mkdir()
        NPM_CACHE.mkdir(parents=True, exist_ok=True)
        env = gate_env(home, NPM_CACHE)
        pwn = Path.home() / "pwned-tenwhy-gate-test"
        gitconfig = str(Path.home() / ".gitconfig")
        if pwn.exists():
            pwn.unlink()
        (tree / "try.mjs").write_text(
            "import fs from 'node:fs';\n"
            "function read(p){ try { fs.readFileSync(p); console.error('READ_OK', p); }"
            "catch (e) { console.error('READ_DENY', p, e.code); } }\n"
            "read('/etc/hosts');\n"
            f"read({gitconfig!r});\n"
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
            self.assertEqual(result.returncode, 0, blob)
            self.assertFalse(pwn.exists(), blob)
            self.assertIn("READ_DENY /etc/hosts", blob)
            self.assertIn("READ_DENY", blob)
            self.assertIn("EPERM", blob)
            self.assertNotIn("FETCH 200", blob)
            self.assertNotIn("READ_OK /etc/hosts", blob)
            self.assertNotIn("READ_OK " + gitconfig, blob)
        finally:
            if pwn.exists():
                pwn.unlink()
            shutil.rmtree(tree, ignore_errors=True)

    @unittest.skipIf(
        os.environ.get("WEBSITE_GATE_SKIP_LIGHTHOUSE") == "1" and os.environ.get("TENWHY_DEV") == "1",
        "lighthouse skipped",
    )
    def test_lighthouse_unrelated_loopback_port_sees_no_request(self):
        hits = []

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                hits.append(self.path)
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b"ok")

            def log_message(self, fmt, *args):
                return

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        port = server.server_address[1]
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        workdir = _copy_case("pass")
        index = workdir / "website" / "index.html"
        html = index.read_text(encoding="utf-8")
        probe = f'<script>fetch("http://127.0.0.1:{port}/unrelated-probe").catch(function(){{}})</script>'
        index.write_text(html.replace("</body>", probe + "</body>"), encoding="utf-8")
        tmp = tempfile.mkdtemp(prefix="tenwhy-webgate-")
        db_path = Path(tmp) / "t.db"
        subprocess.check_call(["bash", str(MIGRATE), str(db_path)], cwd=str(ROOT))
        try:
            proc = subprocess.run(
                [
                    str(PYTHON),
                    str(GATE),
                    "--workdir",
                    str(workdir),
                    "--db",
                    str(db_path),
                    "--loop-run-id",
                    f"run_{uuid.uuid4().hex[:8]}",
                ],
                cwd=str(ROOT),
                capture_output=True,
                text=True,
            )
            self.assertTrue(proc.stdout.strip(), proc.stderr)
            checks = json.loads(proc.stdout.strip().splitlines()[-1])
            lh = next(c for c in checks if c["check_name"] == "lighthouse≥85")
            self.assertTrue(lh["passed"], checks)
            self.assertEqual(hits, [], f"unrelated port received {hits}")
        finally:
            server.shutdown()
            server.server_close()
            shutil.rmtree(workdir, ignore_errors=True)
            shutil.rmtree(tmp, ignore_errors=True)

    def test_fail_links(self):
        checks = self._assert_case("fail_links", 1, "links_ok")
        self.assertIn("broken links", checks[2]["detail"])

    def test_fail_links_css(self):
        checks = self._assert_case("fail_links_css", 1, "links_ok")
        self.assertIn("css", checks[2]["detail"])

    def test_fail_links_inline(self):
        checks = self._assert_case("fail_links_inline", 1, "links_ok")
        self.assertIn("missing-inline.png", checks[2]["detail"])

    def test_fail_links_srcset(self):
        checks = self._assert_case("fail_links_srcset", 1, "links_ok")
        self.assertIn("srcset", checks[2]["detail"])

    def test_srcset_data_uri_commas_are_not_candidates(self):
        sys.path.insert(0, str(GATE.parent))
        from website_gate import srcset_urls

        value = (
            'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="1,2" height="3,4"></svg> 1x, '
            "/images/hero.svg 2x"
        )
        urls = srcset_urls(value)
        self.assertEqual(urls, ["/images/hero.svg"])
        self.assertFalse(any(u.lower().startswith("data:") or "width=" in u for u in urls))

    def test_fail_links_escape(self):
        checks = self._assert_case("fail_links_escape", 1, "links_ok")
        detail = checks[2]["detail"]
        self.assertTrue("outside.png" in detail or "/../" in detail, detail)
        self.assertTrue("%2e%2e" in detail or "secret.png" in detail, detail)
        self.assertTrue("..%2f" in detail or "secret2.png" in detail, detail)
        self.assertTrue("%zz" in detail, detail)
        self.assertTrue("foo" in detail and "bar.png" in detail, detail)
        self.assertIn("IMAGE_BRIEF", detail)

    def test_inspect_ref_order(self):
        sys.path.insert(0, str(GATE.parent))
        from website_gate import inspect_ref

        self.assertEqual(inspect_ref("https://example.com/x")[0], "ignore")
        self.assertEqual(inspect_ref("https://example.com/x", image_brief=True)[0], "reject")
        self.assertEqual(inspect_ref("//cdn.example/x")[0], "ignore")
        self.assertEqual(inspect_ref("//cdn.example/x", image_brief=True)[0], "reject")
        self.assertEqual(inspect_ref("/../outside.png")[0], "reject")
        self.assertEqual(inspect_ref("%2e%2e/secret.png")[0], "reject")
        self.assertEqual(inspect_ref("..%2fsecret2.png")[0], "reject")
        self.assertEqual(inspect_ref("%zz/bad.png")[0], "reject")
        self.assertEqual(inspect_ref("foo\\bar.png")[0], "reject")
        self.assertEqual(inspect_ref("/images/../pwn.svg", image_brief=True)[0], "reject")
        self.assertEqual(inspect_ref("/images/hero.svg")[0], "ok")

    def test_dist_symlink_escape_is_broken(self):
        sys.path.insert(0, str(GATE.parent))
        from website_gate import resolve_in_dist

        tmp = Path(tempfile.mkdtemp())
        dist = tmp / "dist"
        dist.mkdir()
        (dist / "index.html").write_text('<img src="out.png">', encoding="utf-8")
        outside = tmp / "outside.png"
        outside.write_bytes(b"x")
        link = dist / "out.png"
        link.symlink_to(outside)
        resolved = resolve_in_dist(dist, dist / "index.html", "out.png")
        self.assertEqual(str(resolved), "/__outside_dist__")
        shutil.rmtree(tmp)

    def test_fail_placeholders(self):
        checks = self._assert_case("fail_placeholders", 1, "links_ok")
        self.assertIn("unwired placeholders", checks[2]["detail"])
        self.assertIn("/images/unwired.svg", checks[2]["detail"])

    def test_fail_copy(self):
        self._assert_case("fail_copy", 1, "copy_grounded")

    def test_fail_copy_substring(self):
        checks = self._assert_case("fail_copy_substring", 1, "copy_grounded")
        self.assertIn("company.name", checks[3]["detail"])

    def test_chrome_flags_pin_resolver_and_user_data_dir(self):
        sys.path.insert(0, str(GATE.parent))
        from website_gate import chrome_launch_flags

        flags = chrome_launch_flags(Path("/private/tmp/tenwhy-lhprofile"))
        self.assertIn("--headless=new", flags)
        self.assertIn("--no-sandbox", flags)
        self.assertIn("--disable-gpu", flags)
        self.assertIn("--disable-breakpad", flags)
        self.assertIn("--user-data-dir=/private/tmp/tenwhy-lhprofile", flags)
        self.assertIn("MAP * ~NOTFOUND", flags)
        self.assertIn("EXCLUDE 127.0.0.1", flags)

    def test_chrome_launch_failed_detail(self):
        sys.path.insert(0, str(GATE.parent))
        from website_gate import BuildCtx, lighthouse_check

        prev_skip = os.environ.pop("WEBSITE_GATE_SKIP_LIGHTHOUSE", None)
        prev_dev = os.environ.pop("TENWHY_DEV", None)
        try:
            result = lighthouse_check(Path("/tmp"), BuildCtx())
            self.assertFalse(result["passed"])
            self.assertTrue(result["detail"].startswith("chrome launch failed:"), result["detail"])
        finally:
            if prev_skip is not None:
                os.environ["WEBSITE_GATE_SKIP_LIGHTHOUSE"] = prev_skip
            if prev_dev is not None:
                os.environ["TENWHY_DEV"] = prev_dev

    def test_checks_1_to_4_with_empty_home(self):
        prev_home = os.environ.get("HOME")
        empty = tempfile.mkdtemp()
        os.environ["HOME"] = empty
        prev_skip = os.environ.get("WEBSITE_GATE_SKIP_LIGHTHOUSE")
        prev_dev = os.environ.get("TENWHY_DEV")
        os.environ["WEBSITE_GATE_SKIP_LIGHTHOUSE"] = "1"
        os.environ["TENWHY_DEV"] = "1"
        try:
            _rc, checks, _wd = run_case("pass")
            for c in checks[:4]:
                self.assertTrue(c["passed"], c)
        finally:
            if prev_home is None:
                os.environ.pop("HOME", None)
            else:
                os.environ["HOME"] = prev_home
            if prev_skip is None:
                os.environ.pop("WEBSITE_GATE_SKIP_LIGHTHOUSE", None)
            else:
                os.environ["WEBSITE_GATE_SKIP_LIGHTHOUSE"] = prev_skip
            if prev_dev is None:
                os.environ.pop("TENWHY_DEV", None)
            else:
                os.environ["TENWHY_DEV"] = prev_dev
            shutil.rmtree(empty, ignore_errors=True)

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
