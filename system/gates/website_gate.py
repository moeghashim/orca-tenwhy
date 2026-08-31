#!/usr/bin/env python3
"""Website loop exit gate. jsonschema 4.26.0 (venv)."""
from __future__ import annotations

import argparse
import json
import os
import re
import signal
import socket
import subprocess
import sys
import tempfile
import time
import xml.etree.ElementTree as ET
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote, urlparse

import jsonschema

ROOT = Path(__file__).resolve().parent.parent.parent
SCHEMA_PATH = Path(__file__).resolve().parent / "brand_tokens_schema.json"
SKIP_BUILD = "skipped: build_ok failed"
CHECK_NAMES = [
    "brand_assets_valid",
    "build_ok",
    "links_ok",
    "copy_grounded",
    "lighthouse≥85",
]
BUILD_TIMEOUT = 300
IGNORE_SCHEMES = ("http:", "https:", "mailto:", "tel:", "data:", "javascript:")


def check(name: str, passed: bool, detail: str) -> dict:
    return {"check_name": name, "passed": bool(passed), "detail": detail}


def load_schema() -> dict:
    return json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))


def svg_root_ok(path: Path) -> tuple[bool, str]:
    try:
        root = ET.parse(path).getroot()
    except ET.ParseError as exc:
        return False, f"logo.svg xml parse error: {exc}"
    tag = root.tag.split("}", 1)[-1]
    if tag.lower() != "svg":
        return False, f"logo.svg root is <{tag}>, expected <svg>"
    return True, "ok"


def brand_assets(workdir: Path) -> dict:
    tokens_path = workdir / "brand" / "tokens.json"
    logo_path = workdir / "brand" / "logo.svg"
    if not tokens_path.is_file():
        return check("brand_assets_valid", False, f"missing {tokens_path}")
    if not logo_path.is_file():
        return check("brand_assets_valid", False, f"missing {logo_path}")
    try:
        tokens = json.loads(tokens_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        return check("brand_assets_valid", False, f"unparsable tokens.json: {exc}")
    try:
        jsonschema.validate(instance=tokens, schema=load_schema())
    except jsonschema.ValidationError as exc:
        return check("brand_assets_valid", False, f"tokens.json: {exc.message}")
    ok, detail = svg_root_ok(logo_path)
    if not ok:
        return check("brand_assets_valid", False, detail)
    return check("brand_assets_valid", True, "ok")


def last_lines(text: str, n: int = 40) -> str:
    lines = (text or "").splitlines()
    return "\n".join(lines[-n:])


def run_npm(web: Path) -> dict:
    if not web.is_dir():
        return check("build_ok", False, f"missing {web}")
    env = {
        **os.environ,
        "npm_config_audit": "false",
        "npm_config_fund": "false",
        "npm_config_progress": "false",
        "npm_config_update_notifier": "false",
    }
    install = ["npm", "ci"] if (web / "package-lock.json").is_file() else ["npm", "install"]
    try:
        inst = subprocess.run(
            install,
            cwd=web,
            env=env,
            capture_output=True,
            text=True,
            timeout=BUILD_TIMEOUT,
        )
    except subprocess.TimeoutExpired:
        return check("build_ok", False, "npm install timed out after 5 min")
    if inst.returncode != 0:
        return check("build_ok", False, last_lines(inst.stderr or inst.stdout))
    try:
        built = subprocess.run(
            ["npm", "run", "build"],
            cwd=web,
            env=env,
            capture_output=True,
            text=True,
            timeout=BUILD_TIMEOUT,
        )
    except subprocess.TimeoutExpired:
        return check("build_ok", False, "npm run build timed out after 5 min")
    if built.returncode != 0:
        return check("build_ok", False, last_lines(built.stderr or built.stdout))
    dist = web / "dist"
    if not dist.is_dir():
        return check("build_ok", False, "npm run build exited 0 but dist/ is missing")
    return check("build_ok", True, "ok")


def parse_image_brief_paths(text: str) -> list[str]:
    paths: list[str] = []
    header: list[str] | None = None
    path_idx: int | None = None
    for raw in text.splitlines():
        line = raw.strip()
        if not line.startswith("|"):
            continue
        cells = [c.strip() for c in line.strip("|").split("|")]
        if header is None:
            lower = [c.lower() for c in cells]
            if "path" in lower:
                header = lower
                path_idx = lower.index("path")
            continue
        if all(set(c) <= {"-", ":"} for c in cells):
            continue
        if path_idx is None or path_idx >= len(cells):
            continue
        p = cells[path_idx]
        if p:
            paths.append(p)
    return paths


class _HtmlRefs(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.hrefs: list[str] = []
        self.srcs: list[str] = []
        self.srcsets: list[str] = []
        self.img_srcs: list[str] = []
        self._in_img = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        ad = {k.lower(): (v or "") for k, v in attrs}
        if tag == "a" and "href" in ad:
            self.hrefs.append(ad["href"])
        if "src" in ad:
            self.srcs.append(ad["src"])
            if tag == "img":
                self.img_srcs.append(ad["src"])
        if "srcset" in ad:
            self.srcsets.append(ad["srcset"])
        if tag in {"link", "script", "iframe", "source", "img"} and "href" in ad and tag != "a":
            self.hrefs.append(ad["href"])


def html_refs(html: str) -> _HtmlRefs:
    parser = _HtmlRefs()
    try:
        parser.feed(html)
        parser.close()
    except Exception:
        pass
    return parser


def css_urls(text: str) -> list[str]:
    found = []
    for m in re.finditer(r"url\(\s*(['\"]?)([^)'\"]+)\1\s*\)", text, flags=re.I):
        found.append(m.group(2).strip())
    return found


def srcset_urls(value: str) -> list[str]:
    urls = []
    for part in value.split(","):
        token = part.strip().split()
        if token:
            urls.append(token[0])
    return urls


def is_ignored(url: str) -> bool:
    s = url.strip()
    if not s or s.startswith("#"):
        return True
    lower = s.lower()
    return lower.startswith(IGNORE_SCHEMES)


def strip_url(url: str) -> str:
    s = unquote(url.strip())
    s = s.split("#", 1)[0].split("?", 1)[0]
    return s


def resolve_in_dist(dist: Path, from_file: Path, url: str) -> Path | None:
    raw = strip_url(url)
    if is_ignored(raw):
        return None
    dist_real = dist.resolve()
    if raw.startswith("/"):
        target = dist_real / raw.lstrip("/")
    else:
        target = (from_file.parent / raw)
        try:
            target = target.resolve()
        except OSError:
            return Path("/__unresolved__")
    try:
        target.relative_to(dist_real)
    except ValueError:
        return Path("/__outside_dist__")
    candidates = [target]
    if target.suffix == "":
        candidates.extend([target / "index.html", Path(str(target) + ".html")])
    for c in candidates:
        if c.is_file():
            return c
    return target


def visible_text(html: str) -> str:
    stripped = re.sub(r"<script\b[^>]*>[\s\S]*?</script>", " ", html, flags=re.I)
    stripped = re.sub(r"<style\b[^>]*>[\s\S]*?</style>", " ", stripped, flags=re.I)
    stripped = re.sub(r"<[^>]+>", " ", stripped)
    stripped = re.sub(r"\s+", " ", stripped)
    return stripped.strip().lower()


def norm_ws(s: str) -> str:
    return re.sub(r"\s+", " ", s).strip().lower()


def collect_html_files(dist: Path) -> list[Path]:
    if not dist.is_dir():
        return []
    return sorted(p for p in dist.rglob("*.html") if p.is_file())


def links_ok(workdir: Path) -> dict:
    dist = workdir / "website" / "dist"
    brief_path = workdir / "brand" / "IMAGE_BRIEF.md"
    brief_text = brief_path.read_text(encoding="utf-8") if brief_path.is_file() else ""
    brief_paths = parse_image_brief_paths(brief_text)
    html_files = [p.resolve() for p in collect_html_files(dist)]
    broken: list[str] = []
    referenced: set[str] = set()
    dist_real = dist.resolve() if dist.is_dir() else dist

    def note_ref(url: str) -> None:
        raw = strip_url(url)
        if is_ignored(raw):
            return
        referenced.add(raw)
        parsed = urlparse(raw)
        if parsed.path:
            referenced.add(parsed.path)

    for html_file in html_files:
        html = html_file.read_text(encoding="utf-8", errors="replace")
        refs = html_refs(html)
        for url in refs.hrefs + refs.srcs:
            if is_ignored(strip_url(url)):
                continue
            note_ref(url)
            resolved = resolve_in_dist(dist, html_file, url)
            if resolved is None:
                continue
            if not resolved.is_file():
                broken.append(f"{html_file.relative_to(dist_real)} -> {url}")
        for srcset in refs.srcsets:
            for url in srcset_urls(srcset):
                if is_ignored(strip_url(url)):
                    continue
                note_ref(url)
                resolved = resolve_in_dist(dist, html_file, url)
                if resolved is not None and not resolved.is_file():
                    broken.append(f"{html_file.relative_to(dist_real)} srcset -> {url}")
        for url in css_urls(html):
            note_ref(url)

    if dist.is_dir():
        for css in dist.rglob("*.css"):
            if css.is_file():
                for url in css_urls(css.read_text(encoding="utf-8", errors="replace")):
                    note_ref(url)

    unwired: list[str] = []
    missing_files: list[str] = []
    for p in brief_paths:
        rel = p.lstrip("/")
        on_disk = (dist / rel).is_file() if dist.is_dir() else False
        if not on_disk:
            missing_files.append(p)
        wired = p in referenced or ("/" + rel) in referenced or rel in referenced
        if not wired:
            unwired.append(p)

    parts = []
    if broken:
        parts.append("broken links: " + ", ".join(broken))
    placeholder_issues = missing_files + [u for u in unwired if u not in missing_files]
    if placeholder_issues:
        parts.append("unwired placeholders: " + ", ".join(placeholder_issues))
    ok = not broken and not missing_files and not unwired
    return check("links_ok", ok, "ok" if ok else "; ".join(parts))


def copy_grounded(workdir: Path) -> dict:
    research_path = workdir / "research" / "RESEARCH.json"
    dist = workdir / "website" / "dist"
    if not research_path.is_file():
        return check("copy_grounded", False, f"missing {research_path}")
    try:
        data = json.loads(research_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        return check("copy_grounded", False, f"unparsable RESEARCH.json: {exc}")
    company = norm_ws(str((data.get("company") or {}).get("name") or ""))
    products = []
    seen = set()
    for p in (data.get("company") or {}).get("customer_products") or []:
        n = norm_ws(str(p.get("name") or ""))
        if n and n not in seen:
            seen.add(n)
            products.append(n)
    blob = " ".join(
        visible_text(p.read_text(encoding="utf-8", errors="replace")) for p in collect_html_files(dist)
    )
    missing = []
    if not company or company not in blob:
        missing.append(f"company.name {company!r}")
    found_products = [n for n in products if n in blob]
    if len(found_products) < 3:
        missing.append(
            f"need ≥3 product names, found {len(found_products)} of {len(products)}: "
            + ", ".join(found_products or ["(none)"])
        )
    ok = not missing
    return check("copy_grounded", ok, "ok" if ok else "; ".join(missing))


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def wait_port(port: int, timeout: float = 30.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.5):
                return True
        except OSError:
            time.sleep(0.1)
    return False


def stop_pg(proc: subprocess.Popen) -> None:
    if proc.poll() is not None:
        return
    try:
        os.killpg(proc.pid, signal.SIGTERM)
    except (ProcessLookupError, PermissionError, OSError):
        proc.terminate()
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError, OSError):
            proc.kill()


def lighthouse_skip_honoured() -> bool:
    """Skip Lighthouse only when both the skip flag and TENWHY_DEV=1 are set."""
    return os.environ.get("WEBSITE_GATE_SKIP_LIGHTHOUSE") == "1" and os.environ.get("TENWHY_DEV") == "1"


def lighthouse_check(workdir: Path) -> dict:
    if lighthouse_skip_honoured():
        return check("lighthouse≥85", True, "skipped: WEBSITE_GATE_SKIP_LIGHTHOUSE=1")
    web = workdir / "website"
    port = free_port()
    env = {**os.environ, "BROWSER": "none"}
    preview = subprocess.Popen(
        ["npx", "vite", "preview", "--port", str(port), "--strictPort", "--host", "127.0.0.1"],
        cwd=web,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        start_new_session=True,
    )
    out_json = Path(tempfile.mkdtemp(prefix="tenwhy-lh-")) / "lh.json"
    try:
        if not wait_port(port, timeout=30):
            err = ""
            if preview.stderr:
                try:
                    err = preview.stderr.read()[-2000:]
                except Exception:
                    err = ""
            return check("lighthouse≥85", False, f"vite preview did not bind :{port} {err}".strip())
        cmd = [
            "lighthouse",
            f"http://127.0.0.1:{port}/",
            "--only-categories=performance,accessibility",
            "--output=json",
            f"--output-path={out_json}",
            "--chrome-flags=--headless=new",
            "--quiet",
        ]
        try:
            lh = subprocess.run(cmd, capture_output=True, text=True, timeout=180)
        except subprocess.TimeoutExpired:
            return check("lighthouse≥85", False, "lighthouse timed out")
        if lh.returncode != 0 or not out_json.is_file():
            return check(
                "lighthouse≥85",
                False,
                last_lines((lh.stderr or lh.stdout or "lighthouse failed"), 40),
            )
        data = json.loads(out_json.read_text(encoding="utf-8"))
        cats = data.get("categories") or {}
        perf = (cats.get("performance") or {}).get("score")
        a11y = (cats.get("accessibility") or {}).get("score")
        if not isinstance(perf, (int, float)) or not isinstance(a11y, (int, float)):
            return check("lighthouse≥85", False, f"missing scores performance={perf} accessibility={a11y}")
        perf_n = perf * 100
        a11y_n = a11y * 100
        detail = f"performance={perf_n:.0f} accessibility={a11y_n:.0f}"
        ok = perf_n >= 85 and a11y_n >= 85
        return check("lighthouse≥85", ok, detail)
    finally:
        stop_pg(preview)
        try:
            out_json.unlink(missing_ok=True)
            out_json.parent.rmdir()
        except OSError:
            pass


def run_checks(workdir: Path) -> list[dict]:
    brand = brand_assets(workdir)
    built = run_npm(workdir / "website")
    if not built["passed"]:
        return [
            brand,
            built,
            check("links_ok", False, SKIP_BUILD),
            check("copy_grounded", False, SKIP_BUILD),
            check("lighthouse≥85", False, SKIP_BUILD),
        ]
    return [
        brand,
        built,
        links_ok(workdir),
        copy_grounded(workdir),
        lighthouse_check(workdir),
    ]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="website_gate.py")
    parser.add_argument("--workdir", required=True)
    parser.add_argument("--db", required=True)
    parser.add_argument("--loop-run-id", required=True)
    args = parser.parse_args(argv)
    checks = run_checks(Path(args.workdir))
    print(json.dumps(checks, ensure_ascii=False))
    return 0 if checks and all(c["passed"] for c in checks) else 1


if __name__ == "__main__":
    sys.exit(main())
