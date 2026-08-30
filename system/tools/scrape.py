#!/usr/bin/env python3
"""Fetch a URL with Scrapling and persist a scrapes row.

CLI:
  scrape.py --url <url> --loop-run-id <id> [--db <path>] [--out-dir <dir>] [--allowlist host1,host2]
"""
from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import sqlite3
import sys
import time
import uuid
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

from scrapling.fetchers import Fetcher
from protego import Protego

USER_AGENT = "tenwhy-research/1.0"
RATE_LIMIT_S = 2.0
TIMEOUT_S = 30
TEXT_MAX_CHARS = 200 * 1024
EXIT_OK = 0
EXIT_REFUSED = 3
EXIT_ERROR = 4
REDIRECT_STATUSES = {301, 302, 303, 307, 308}
MAX_REDIRECTS = 5
# RFC 9309 §2.3.1.3–4: 401/403 and 5xx/unreachable robots.txt → assume full disallow;
# 404 (and other 4xx) → no restrictions.
ROBOTS_DISALLOW_STATUSES = {401, 403}

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
DEFAULT_DB = REPO_ROOT / "state" / "orchestrator.db"
RATE_DIR = REPO_ROOT / "state" / "scrape"


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def new_id() -> str:
    return str(uuid.uuid4())


def open_db(path: Path) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path))
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def lookup_engagement_id(conn: sqlite3.Connection, loop_run_id: str) -> str | None:
    row = conn.execute(
        "SELECT engagement_id FROM loop_runs WHERE id = ?", (loop_run_id,)
    ).fetchone()
    return row[0] if row else None


def insert_event(
    conn: sqlite3.Connection,
    *,
    engagement_id: str | None,
    loop_run_id: str,
    kind: str,
    payload: dict,
) -> None:
    conn.execute(
        "INSERT INTO events (engagement_id, loop_run_id, kind, payload, created_at) VALUES (?, ?, ?, ?, ?)",
        (engagement_id, loop_run_id, kind, json.dumps(payload), utc_now()),
    )


def insert_scrape(
    conn: sqlite3.Connection,
    *,
    loop_run_id: str,
    url: str,
    http_status: int | None,
    content_path: str | None,
) -> None:
    conn.execute(
        "INSERT INTO scrapes (id, loop_run_id, url, http_status, content_path, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        (new_id(), loop_run_id, url, http_status, content_path, utc_now()),
    )


def refuse(
    conn: sqlite3.Connection, url: str, loop_run_id: str, reason: str, at: str | None = None
) -> int:
    engagement_id = lookup_engagement_id(conn, loop_run_id)
    insert_scrape(
        conn, loop_run_id=loop_run_id, url=url, http_status=None, content_path=None
    )
    payload = {"url": url, "reason": reason}
    if at and at != url:
        payload["at"] = at  # refusal happened on a redirect hop
    insert_event(
        conn,
        engagement_id=engagement_id,
        loop_run_id=loop_run_id,
        kind="scrape_refused",
        payload=payload,
    )
    conn.commit()
    out = {"url": url, "refused": True, "reason": reason}
    if "at" in payload:
        out["at"] = at
    print(json.dumps(out))
    return EXIT_REFUSED


def fail(conn: sqlite3.Connection, url: str, loop_run_id: str, error: str) -> int:
    engagement_id = lookup_engagement_id(conn, loop_run_id)
    insert_event(
        conn,
        engagement_id=engagement_id,
        loop_run_id=loop_run_id,
        kind="scrape_error",
        payload={"url": url, "error": error},
    )
    conn.commit()
    print(json.dumps({"url": url, "error": error}), file=sys.stderr)
    return EXIT_ERROR


def host_of(url: str) -> str:
    host = urllib.parse.urlparse(url).hostname
    if not host:
        raise ValueError(f"URL has no host: {url}")
    return host.lower()


def origin_of(url: str) -> str:
    parts = urllib.parse.urlparse(url)
    if not parts.scheme or not parts.netloc:
        raise ValueError(f"URL missing scheme/netloc: {url}")
    return f"{parts.scheme}://{parts.netloc}"


def safe_filename(host: str) -> str:
    return "".join(c if c.isalnum() or c in ".-_" else "_" for c in host)


def rate_limit(host: str) -> None:
    RATE_DIR.mkdir(parents=True, exist_ok=True)
    path = RATE_DIR / f"{safe_filename(host)}.last"
    path.touch(exist_ok=True)
    with path.open("r+") as fh:
        fcntl.flock(fh, fcntl.LOCK_EX)
        try:
            raw = fh.read().strip()
            last = float(raw) if raw else 0.0
            now = time.time()
            wait = RATE_LIMIT_S - (now - last)
            if wait > 0:
                time.sleep(wait)
            fh.seek(0)
            fh.truncate()
            fh.write(f"{time.time():.6f}\n")
            fh.flush()
        finally:
            fcntl.flock(fh, fcntl.LOCK_UN)


def load_robots(url: str, out_dir: Path) -> tuple[int | None, str]:
    """Return (HTTP status or None on network error, body). Cached per host as JSON;
    network errors are not cached so a transient failure is retried next time."""
    host = host_of(url)
    cache = out_dir / "robots" / f"{safe_filename(host)}.json"
    cache.parent.mkdir(parents=True, exist_ok=True)
    if cache.exists():
        try:
            data = json.loads(cache.read_text(encoding="utf-8"))
            return data.get("status"), str(data.get("body", ""))
        except (ValueError, OSError):
            pass
    robots_url = origin_of(url) + "/robots.txt"
    req = urllib.request.Request(robots_url, headers={"User-Agent": USER_AGENT})
    status: int | None = None
    body = ""
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_S) as resp:
            status = int(resp.status)
            body = resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        status = int(exc.code)
    except Exception:
        status = None
    if status is not None:
        cache.write_text(json.dumps({"status": status, "body": body}), encoding="utf-8")
    return status, body


def robots_allows(url: str, out_dir: Path) -> tuple[bool, str | None]:
    """(allowed, note). note is a refusal reason when not allowed, or an informational
    tag ("robots_absent") when allowed without rules."""
    status, body = load_robots(url, out_dir)
    if status is None or status >= 500 or status in ROBOTS_DISALLOW_STATUSES:
        return False, "robots_unavailable"
    if status >= 400:
        return True, "robots_absent"
    # protego (Google's robots.txt spec: `*` and `$` wildcards, blank lines inside a
    # record) — urllib.robotparser silently drops every rule after a blank line that
    # follows `User-agent: *`, which allowed disallowed GitHub paths (found 2026-08-30).
    allowed = Protego.parse(body).can_fetch(url, USER_AGENT)
    return bool(allowed), (None if allowed else "robots")


def guard(url: str, allowed_hosts: set[str] | None, out_dir: Path) -> tuple[str | None, str | None]:
    """Run the allowlist + robots guardrails for one URL (called on every redirect hop).
    Returns (refusal_reason, robots_note)."""
    host = host_of(url)
    if allowed_hosts is not None and host not in allowed_hosts:
        return "allowlist", None
    allowed, note = robots_allows(url, out_dir)
    if not allowed:
        return note or "robots", None
    return None, note


def header(response, name: str) -> str | None:
    headers = getattr(response, "headers", None) or {}
    for key, value in dict(headers).items():
        if str(key).lower() == name.lower():
            return str(value)
    return None


def normalize_text(text: str) -> str:
    collapsed = " ".join(str(text).split())
    if len(collapsed) > TEXT_MAX_CHARS:
        return collapsed[:TEXT_MAX_CHARS]
    return collapsed


def extract(response, url: str, robots_note: str | None, redirect_chain: list[str] | None = None) -> dict:
    title_els = response.css("title") if hasattr(response, "css") else []
    title = ""
    if title_els:
        title = str(title_els[0].text or "").strip()
    visible = ""
    if hasattr(response, "get_all_text"):
        visible = str(response.get_all_text(separator=" ", strip=True) or "")
    links = []
    final_url = str(getattr(response, "url", url) or url)
    for el in response.css("a") if hasattr(response, "css") else []:
        href = (el.attrib or {}).get("href")
        if not href:
            continue
        links.append(
            {
                "href": urllib.parse.urljoin(final_url, href),
                "text": normalize_text(str(el.text or "")),
            }
        )
    payload = {
        "url": url,
        "final_url": final_url,
        "http_status": int(getattr(response, "status", 0) or 0),
        "title": title,
        "text": normalize_text(visible),
        "links": links,
        "fetched_at": utc_now(),
    }
    if robots_note:
        payload["robots_note"] = robots_note
    if redirect_chain:
        payload["redirect_chain"] = redirect_chain
    return payload


def fetch(url: str):
    return Fetcher.get(
        url,
        timeout=TIMEOUT_S,
        follow_redirects=False,  # hops are walked in main() so every hop is guarded
        stealthy_headers=False,
        headers={"User-Agent": USER_AGENT},
    )


def raw_html(response) -> bytes:
    body = getattr(response, "body", None)
    if isinstance(body, (bytes, bytearray)):
        return bytes(body)
    html = getattr(response, "html_content", None)
    if html is not None:
        return str(html).encode("utf-8", errors="replace")
    return b""


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="scrape.py")
    parser.add_argument("--url", required=True)
    parser.add_argument("--loop-run-id", required=True)
    parser.add_argument("--db", default=None)
    parser.add_argument("--out-dir", default=None)
    parser.add_argument("--allowlist", default=None, help="comma-separated hostnames")
    args = parser.parse_args(argv)

    url = args.url
    loop_run_id = args.loop_run_id
    db_path = Path(args.db or __import__("os").environ.get("TENWHY_DB") or DEFAULT_DB)
    out_dir = Path(args.out_dir) if args.out_dir else (REPO_ROOT / "state" / "scrapes" / loop_run_id)
    out_dir.mkdir(parents=True, exist_ok=True)

    conn = open_db(db_path)
    try:
        try:
            host = host_of(url)
        except ValueError as exc:
            return fail(conn, url, loop_run_id, str(exc))

        allowed_hosts = None
        if args.allowlist:
            allowed_hosts = {h.strip().lower() for h in args.allowlist.split(",") if h.strip()}

        # Walk redirects manually: allowlist, robots and the per-host rate limit are
        # re-applied on every hop so a redirect cannot bypass a guardrail.
        current = url
        redirect_chain: list[str] = []
        response = None
        robots_note = None
        for hop in range(MAX_REDIRECTS + 1):
            try:
                hop_host = host_of(current)
            except ValueError as exc:
                return fail(conn, url, loop_run_id, str(exc))
            reason, robots_note = guard(current, allowed_hosts, out_dir)
            if reason:
                return refuse(conn, url, loop_run_id, reason, at=current)
            try:
                rate_limit(hop_host)
                response = fetch(current)
            except Exception as exc:
                return fail(conn, url, loop_run_id, f"{type(exc).__name__}: {exc}")
            status_code = int(getattr(response, "status", 0) or 0)
            location = header(response, "Location") if status_code in REDIRECT_STATUSES else None
            if not location:
                break
            if hop == MAX_REDIRECTS:
                return fail(conn, url, loop_run_id, f"too many redirects (> {MAX_REDIRECTS})")
            redirect_chain.append(current)
            current = urllib.parse.urljoin(current, location)

        digest = hashlib.sha1(url.encode("utf-8")).hexdigest()
        html_path = out_dir / f"{digest}.html"
        json_path = out_dir / f"{digest}.json"
        html_path.write_bytes(raw_html(response))
        payload = extract(response, url, robots_note, redirect_chain)
        json_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        content_path = str(json_path)
        http_status = payload["http_status"]

        insert_scrape(
            conn,
            loop_run_id=loop_run_id,
            url=url,
            http_status=http_status,
            content_path=content_path,
        )
        insert_event(
            conn,
            engagement_id=lookup_engagement_id(conn, loop_run_id),
            loop_run_id=loop_run_id,
            kind="scrape.fetched",
            payload={"url": url, "http_status": http_status, "content_path": content_path},
        )
        conn.commit()
        print(json.dumps({"url": url, "http_status": http_status, "content_path": content_path}))
        return EXIT_OK
    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())
