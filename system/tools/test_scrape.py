#!/usr/bin/env python3
"""CLI tests for scrape.py against a local HTTP server."""
from __future__ import annotations

import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
SCRAPE = REPO_ROOT / "system" / "tools" / "scrape.py"
MIGRATE = REPO_ROOT / "system" / "db" / "migrate.sh"
PYTHON = sys.executable

OK_HTML = b"""<!doctype html>
<html><head><title>OK Page</title></head>
<body><h1>OK Page</h1><p>Hello from ok.html</p><a href="/next">Next</a></body>
</html>
"""
SECRET_HTML = b"""<!doctype html>
<html><head><title>Secret</title></head><body>nope</body></html>
"""
# Real-world shape (mirrors github.com): blank line right after the UA line, `*`
# and `$` wildcards. urllib.robotparser drops every rule after that blank line;
# scrape.py must use a spec-compliant parser (protego).
ROBOTS = b"User-agent: bingbot\nDisallow: /nothing/\n\nUser-agent: *\n\nDisallow: /blocked/\nDisallow: /*q=\nDisallow: /exact$\n"


class FixtureHandler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        return

    def do_GET(self):
        if self.path == "/robots.txt":
            body, status = ROBOTS, 200
        elif self.path == "/ok.html":
            body, status = OK_HTML, 200
        elif self.path == "/blocked/secret.html":
            body, status = SECRET_HTML, 200
        elif self.path in ("/wild?q=1", "/exact", "/exact/child"):
            body, status = OK_HTML, 200
        elif self.path.startswith("/redir-"):
            port = self.server.server_address[1]
            target = {
                "/redir-ok": "/ok.html",
                "/redir-blocked": "/blocked/secret.html",
                "/redir-offhost": f"http://localhost:{port}/ok.html",
                "/redir-loop": "/redir-loop",
            }.get(self.path)
            if target is None:
                body, status = b"missing", 404
            else:
                self.send_response(302)
                self.send_header("Location", target)
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
        else:
            body, status = b"missing", 404
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class ForbiddenRobotsHandler(FixtureHandler):
    """A host whose robots.txt answers 403 — must be treated as full disallow."""

    def do_GET(self):
        if self.path == "/robots.txt":
            self.send_response(403)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        super().do_GET()


class ScrapeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmpdir = tempfile.mkdtemp(prefix="tenwhy-scrape-")
        cls.db = os.path.join(cls.tmpdir, "test.db")
        subprocess.check_call(["bash", str(MIGRATE), cls.db], cwd=str(REPO_ROOT))
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), FixtureHandler)
        cls.port = cls.httpd.server_address[1]
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = f"http://127.0.0.1:{cls.port}"
        cls.httpd2 = ThreadingHTTPServer(("127.0.0.1", 0), ForbiddenRobotsHandler)
        cls.port2 = cls.httpd2.server_address[1]
        threading.Thread(target=cls.httpd2.serve_forever, daemon=True).start()
        cls.base2 = f"http://127.0.0.1:{cls.port2}"
        last = REPO_ROOT / "state" / "scrape" / "127.0.0.1.last"
        if last.exists():
            last.unlink()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.httpd2.shutdown()
        cls.httpd2.server_close()

    def _run(self, url: str, extra: list[str] | None = None) -> subprocess.CompletedProcess:
        out_dir = tempfile.mkdtemp(dir=self.tmpdir)
        cmd = [
            PYTHON,
            str(SCRAPE),
            "--url",
            url,
            "--loop-run-id",
            "test-run",
            "--db",
            self.db,
            "--out-dir",
            out_dir,
        ]
        if extra:
            cmd.extend(extra)
        return subprocess.run(cmd, cwd=str(REPO_ROOT), capture_output=True, text=True)

    def _conn(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db)
        conn.row_factory = sqlite3.Row
        return conn

    def test_ok_html_200(self):
        url = f"{self.base}/ok.html"
        proc = self._run(url)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        payload = json.loads(proc.stdout.strip().splitlines()[-1])
        self.assertEqual(payload["url"], url)
        self.assertEqual(payload["http_status"], 200)
        self.assertTrue(payload["content_path"])
        with open(payload["content_path"], encoding="utf-8") as fh:
            extracted = json.load(fh)
        self.assertEqual(extracted["title"], "OK Page")
        self.assertIn("Hello from ok.html", extracted["text"])
        with self._conn() as conn:
            row = conn.execute(
                "SELECT http_status, content_path FROM scrapes WHERE url = ? ORDER BY created_at DESC LIMIT 1",
                (url,),
            ).fetchone()
            self.assertIsNotNone(row)
            self.assertEqual(row["http_status"], 200)
            self.assertEqual(row["content_path"], payload["content_path"])

    def test_robots_blocked(self):
        url = f"{self.base}/blocked/secret.html"
        proc = self._run(url)
        self.assertEqual(proc.returncode, 3, proc.stderr + proc.stdout)
        payload = json.loads(proc.stdout.strip().splitlines()[-1])
        self.assertTrue(payload["refused"])
        self.assertEqual(payload["reason"], "robots")
        with self._conn() as conn:
            scrape = conn.execute(
                "SELECT http_status, content_path FROM scrapes WHERE url = ? ORDER BY created_at DESC LIMIT 1",
                (url,),
            ).fetchone()
            self.assertIsNotNone(scrape)
            self.assertIsNone(scrape["http_status"])
            self.assertIsNone(scrape["content_path"])
            event = conn.execute(
                "SELECT kind, payload FROM events WHERE loop_run_id = ? AND kind = 'scrape_refused' ORDER BY id DESC LIMIT 1",
                ("test-run",),
            ).fetchone()
            self.assertIsNotNone(event)
            body = json.loads(event["payload"])
            self.assertEqual(body["url"], url)
            self.assertEqual(body["reason"], "robots")

    def test_robots_wildcard_and_blank_line(self):
        # `/*q=` wildcard → refused; `/exact$` → only the exact path is refused
        for url, expect_refused in (
            (f"{self.base}/wild?q=1", True),
            (f"{self.base}/exact", True),
            (f"{self.base}/exact/child", False),
        ):
            proc = self._run(url)
            if expect_refused:
                self.assertEqual(proc.returncode, 3, url)
                payload = json.loads(proc.stdout.strip().splitlines()[-1])
                self.assertTrue(payload["refused"], url)
                self.assertEqual(payload["reason"], "robots", url)
            else:
                self.assertEqual(proc.returncode, 0, url + "\n" + proc.stderr)

    def _refusal(self, proc, reason: str):
        self.assertEqual(proc.returncode, 3, proc.stderr + proc.stdout)
        payload = json.loads(proc.stdout.strip().splitlines()[-1])
        self.assertTrue(payload["refused"])
        self.assertEqual(payload["reason"], reason)
        return payload

    def test_redirect_followed_with_final_url(self):
        proc = self._run(f"{self.base}/redir-ok")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        payload = json.loads(proc.stdout.strip().splitlines()[-1])
        self.assertEqual(payload["http_status"], 200)
        with open(payload["content_path"], encoding="utf-8") as fh:
            extracted = json.load(fh)
        self.assertTrue(extracted["final_url"].endswith("/ok.html"))
        self.assertEqual(extracted["redirect_chain"], [f"{self.base}/redir-ok"])
        self.assertEqual(extracted["title"], "OK Page")

    def test_redirect_into_robots_blocked_is_refused(self):
        payload = self._refusal(self._run(f"{self.base}/redir-blocked"), "robots")
        self.assertTrue(payload["at"].endswith("/blocked/secret.html"))

    def test_redirect_offhost_hits_allowlist(self):
        payload = self._refusal(
            self._run(f"{self.base}/redir-offhost", ["--allowlist", "127.0.0.1"]), "allowlist"
        )
        self.assertTrue(payload["at"].startswith("http://localhost:"))

    def test_redirect_loop_fails(self):
        proc = self._run(f"{self.base}/redir-loop")
        self.assertEqual(proc.returncode, 4, proc.stdout + proc.stderr)
        self.assertIn("too many redirects", proc.stderr)

    def test_robots_403_means_disallow(self):
        self._refusal(self._run(f"{self.base2}/ok.html"), "robots_unavailable")

    def test_allowlist_refused(self):
        url = f"{self.base}/ok.html"
        proc = self._run(url, extra=["--allowlist", "example.com"])
        self.assertEqual(proc.returncode, 3, proc.stderr + proc.stdout)
        payload = json.loads(proc.stdout.strip().splitlines()[-1])
        self.assertTrue(payload["refused"])
        self.assertEqual(payload["reason"], "allowlist")
        with self._conn() as conn:
            event = conn.execute(
                "SELECT payload FROM events WHERE kind = 'scrape_refused' ORDER BY id DESC LIMIT 1"
            ).fetchone()
            self.assertEqual(json.loads(event["payload"])["reason"], "allowlist")

    def test_missing_404(self):
        url = f"{self.base}/missing"
        proc = self._run(url)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        payload = json.loads(proc.stdout.strip().splitlines()[-1])
        self.assertEqual(payload["http_status"], 404)
        with self._conn() as conn:
            row = conn.execute(
                "SELECT http_status FROM scrapes WHERE url = ? ORDER BY created_at DESC LIMIT 1",
                (url,),
            ).fetchone()
            self.assertEqual(row["http_status"], 404)

    def test_rate_limit_two_fetches(self):
        last = REPO_ROOT / "state" / "scrape" / "127.0.0.1.last"
        if last.exists():
            last.unlink()
        url = f"{self.base}/ok.html"
        t0 = time.monotonic()
        first = self._run(url)
        second = self._run(url)
        elapsed = time.monotonic() - t0
        self.assertEqual(first.returncode, 0, first.stderr)
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertGreaterEqual(elapsed, 2.0)


if __name__ == "__main__":
    unittest.main()
