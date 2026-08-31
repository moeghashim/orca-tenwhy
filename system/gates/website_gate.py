#!/usr/bin/env python3
"""Website loop exit gate. jsonschema 4.26.0 (venv)."""
from __future__ import annotations

import argparse
import fnmatch
import json
import os
import re
import unicodedata
import shutil
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import time
import xml.etree.ElementTree as ET
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote, urlparse
import posixpath

import jsonschema

ROOT = Path(__file__).resolve().parent.parent.parent
SCHEMA_PATH = Path(__file__).resolve().parent / "brand_tokens_schema.json"
PKG_SCHEMA_PATH = Path(__file__).resolve().parent / "website_package_schema.json"
VITE_TEMPLATE = Path(__file__).resolve().parent / "vite.config.template.mjs"
SANDBOX_EXEC = Path("/usr/bin/sandbox-exec")
SANDBOX_DIR = Path(__file__).resolve().parent / "sandbox"
NPM_CACHE = ROOT / "state" / "npm-cache"
VITE_BIN = Path("node_modules/vite/bin/vite.js")
GATE_PATH = "/opt/homebrew/bin:/usr/bin:/bin"
OPERATOR_HOME = str(Path.home())
CRASHPAD_DIR = str(Path.home() / "Library" / "Application Support" / "Google" / "Chrome" / "Crashpad")
PREFS_DIR = str(Path.home() / "Library" / "Preferences")
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


FORBIDDEN_BASE = (
    "vite.config.*",
    "*.config.js",
    "*.config.cjs",
    "*.config.mjs",
    "*.config.ts",
    "*.config.mts",
    "*.config.cts",
    ".postcssrc*",
    "postcss.config.*",
    "tailwind.config.*",
    ".browserslistrc",
    "browserslist.config.*",
    "tsconfig*",
    "jsconfig*",
    ".env*",
    ".npmrc",
    ".yarnrc*",
    ".pnpmfile*",
    "pnpm-workspace.*",
    "package-lock.json",
    "yarn.lock",
    "pnpm-lock.yaml",
)


def forbidden_rel(rel: str) -> str | None:
    posix = rel.replace("\\", "/")
    parts = [p for p in posix.split("/") if p and p != "."]
    name = parts[-1] if parts else posix
    if any(p in {"node_modules", "dist", ".git"} for p in parts):
        return f"forbidden executable/config file: {posix}"
    for pat in FORBIDDEN_BASE:
        if fnmatch.fnmatch(name, pat):
            return f"forbidden executable/config file: {posix}"
    return None


def scan_forbidden(web: Path) -> str | None:
    if not web.is_dir():
        return None
    for dirpath, dirnames, filenames in os.walk(web, followlinks=False):
        rel_dir = os.path.relpath(dirpath, web)
        for d in list(dirnames):
            p = Path(dirpath) / d
            rel = str(Path(rel_dir) / d) if rel_dir != "." else d
            if p.is_symlink():
                return f"forbidden executable/config file: {rel}"
            why = forbidden_rel(rel)
            if why:
                return why
        for f in filenames:
            p = Path(dirpath) / f
            rel = str(Path(rel_dir) / f) if rel_dir != "." else f
            if p.is_symlink():
                return f"forbidden executable/config file: {rel}"
            why = forbidden_rel(rel)
            if why:
                return why
            try:
                st = p.lstat()
            except OSError:
                continue
            if stat.S_ISLNK(st.st_mode):
                return f"forbidden executable/config file: {rel}"
    return None


def validate_package(pkg: dict) -> str | None:
    try:
        jsonschema.validate(instance=pkg, schema=json.loads(PKG_SCHEMA_PATH.read_text(encoding="utf-8")))
    except jsonschema.ValidationError as exc:
        named = str(exc.path[-1]) if exc.path else "package.json"
        return f"package.json: {named}: {exc.message}"
    deps: dict = {}
    for field in ("dependencies", "devDependencies"):
        block = pkg.get(field) or {}
        if not isinstance(block, dict):
            return f"package.json: {field}"
        deps.update(block)
    if set(deps) != {"vite"}:
        extra = set(deps) - {"vite"}
        return f"package.json: {next(iter(extra or {'vite'}))}"
    return None


def node_paths() -> tuple[str, str]:
    node = shutil.which("node") or "/opt/homebrew/bin/node"
    try:
        real = str(Path(node).resolve())
    except OSError:
        real = node
    return node, real


def darwin_user_temp() -> str:
    result = subprocess.run(["getconf", "DARWIN_USER_TEMP_DIR"], capture_output=True, text=True)
    raw = (result.stdout or "").strip() or tempfile.gettempdir()
    try:
        return str(Path(raw).resolve())
    except OSError:
        return raw


def seatbelt_profile(
    phase: str,
    tree: Path,
    cache: Path,
    home: Path,
    *,
    preview_port: int | None = None,
    devtools_port: int | None = None,
    tmpdir: Path | None = None,
) -> str:
    template = SANDBOX_DIR / f"{phase}.sb"
    if not template.is_file():
        raise FileNotFoundError(f"sandbox profile missing: {template}")
    node, node_real = node_paths()
    tmp = tmpdir or (Path(home) / "tmp")
    text = template.read_text(encoding="utf-8")
    repl = {
        "__TREE__": str(tree),
        "__CACHE__": str(cache),
        "__HOME__": str(home),
        "__TMPDIR__": str(tmp),
        "__NODE__": node,
        "__NODE_REAL__": node_real,
        "__OPERATOR_HOME__": OPERATOR_HOME,
        "__USER_TEMP__": darwin_user_temp(),
        "__CRASHPAD__": CRASHPAD_DIR,
        "__PREFS__": PREFS_DIR,
        "__PREVIEW_PORT__": str(preview_port or 0),
        "__DEVTOOLS_PORT__": str(devtools_port or 0),
    }
    for key, value in repl.items():
        text = text.replace(key, value)
    return text


def gate_env(home: Path, cache: Path) -> dict:
    user = home / ".npmrc"
    glob = home / "npmrc-global"
    tmp = home / "tmp"
    tmp.mkdir(parents=True, exist_ok=True)
    user.write_text("", encoding="utf-8")
    glob.write_text("", encoding="utf-8")
    return {
        "HOME": str(home),
        "PATH": GATE_PATH,
        "NPM_CONFIG_USERCONFIG": str(user),
        "NPM_CONFIG_GLOBALCONFIG": str(glob),
        "npm_config_cache": str(cache),
        "LANG": "C",
        "LC_ALL": "C",
        "TMPDIR": str(tmp),
    }


def run_in_sandbox(
    phase: str,
    argv: list[str],
    *,
    tree: Path,
    cache: Path,
    home: Path,
    env: dict,
    timeout: int = BUILD_TIMEOUT,
    preview_port: int | None = None,
    devtools_port: int | None = None,
) -> subprocess.CompletedProcess:
    if not SANDBOX_EXEC.is_file():
        return subprocess.CompletedProcess(argv, 127, "", "sandbox unavailable")
    profile = tree / f".seatbelt-{phase}.sb"
    tmpdir = Path(env.get("TMPDIR") or (home / "tmp"))
    try:
        body = seatbelt_profile(
            phase,
            tree,
            cache,
            home,
            preview_port=preview_port,
            devtools_port=devtools_port,
            tmpdir=tmpdir,
        )
    except FileNotFoundError:
        return subprocess.CompletedProcess(argv, 127, "", "sandbox unavailable")
    profile.write_text(body, encoding="utf-8")
    cmd = [str(SANDBOX_EXEC), "-f", str(profile), *argv]
    try:
        return subprocess.run(cmd, cwd=tree, env=env, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return subprocess.CompletedProcess(cmd, 124, "", f"{phase} timed out")


def copy_allowed_tree(src: Path, dest: Path) -> str | None:
    dest.mkdir(parents=True, exist_ok=True)
    for dirpath, dirnames, filenames in os.walk(src, followlinks=False):
        rel_dir = os.path.relpath(dirpath, src)
        dirnames[:] = [d for d in dirnames if d not in {"node_modules", "dist", ".git"}]
        for d in list(dirnames):
            p = Path(dirpath) / d
            if p.is_symlink():
                rel = str(Path(rel_dir) / d) if rel_dir != "." else d
                return f"forbidden executable/config file: {rel}"
        for f in filenames:
            p = Path(dirpath) / f
            rel = str(Path(rel_dir) / f) if rel_dir != "." else f
            if p.is_symlink() or not p.is_file():
                return f"forbidden executable/config file: {rel}"
            st = p.lstat()
            if not stat.S_ISREG(st.st_mode) or st.st_nlink != 1:
                return f"forbidden executable/config file: {rel}"
            why = forbidden_rel(rel)
            if why:
                return why
            target = dest / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(p, target)
    return None


def write_vite_config(tree: Path) -> list[str]:
    htmls = sorted(p.name for p in tree.glob("*.html") if p.is_file())
    mapping = {Path(name).stem: name for name in htmls}
    raw = VITE_TEMPLATE.read_text(encoding="utf-8")
    (tree / "vite.config.mjs").write_text(raw.replace("__INPUT__", json.dumps(mapping, indent=2)), encoding="utf-8")
    return htmls


class BuildCtx:
    def __init__(self) -> None:
        self.tree: Path | None = None
        self.home: Path | None = None
        self.env: dict = {}
        self.htmls: list[str] = []


def run_build(web: Path, loop_run_id: str) -> tuple[dict, BuildCtx]:
    ctx = BuildCtx()
    if not web.is_dir():
        return check("build_ok", False, f"missing {web}"), ctx
    why = scan_forbidden(web)
    if why:
        return check("build_ok", False, why), ctx
    pkg_path = web / "package.json"
    if not pkg_path.is_file():
        return check("build_ok", False, "missing package.json"), ctx
    try:
        pkg = json.loads(pkg_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        return check("build_ok", False, f"package.json: {exc}"), ctx
    named = validate_package(pkg)
    if named:
        return check("build_ok", False, named), ctx
    if not SANDBOX_EXEC.is_file():
        return check("build_ok", False, "sandbox unavailable"), ctx

    safe = re.sub(r"[^a-zA-Z0-9._-]+", "-", loop_run_id)[:80] or "run"
    tree = Path("/private/tmp") / f"tenwhy-gate-{safe}"
    if tree.exists():
        shutil.rmtree(tree)
    tree.mkdir(parents=True)
    ctx.tree = tree
    copied = copy_allowed_tree(web, tree)
    if copied:
        return check("build_ok", False, copied), ctx
    ctx.htmls = write_vite_config(tree)
    if not ctx.htmls:
        return check("build_ok", False, "no root-level *.html"), ctx

    NPM_CACHE.mkdir(parents=True, exist_ok=True)
    home = tree / ".gate-home"
    home.mkdir()
    ctx.home = home
    ctx.env = gate_env(home, NPM_CACHE)
    vite_range = (pkg.get("devDependencies") or pkg.get("dependencies") or {}).get("vite")
    view = run_in_sandbox(
        "install",
        ["npm", "view", f"vite@{vite_range}", "version", "--json"],
        tree=tree,
        cache=NPM_CACHE,
        home=home,
        env=ctx.env,
        timeout=120,
    )
    if view.returncode != 0:
        return check("build_ok", False, last_lines(view.stderr or view.stdout or "npm view failed")), ctx
    try:
        ver = json.loads((view.stdout or "").strip() or '""')
        if isinstance(ver, list):
            ver = ver[-1]
        ver = str(ver).strip()
    except json.JSONDecodeError:
        return check("build_ok", False, "npm view vite version: unparsable"), ctx
    inst = run_in_sandbox(
        "install",
        ["npm", "install", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock", f"vite@{ver}"],
        tree=tree,
        cache=NPM_CACHE,
        home=home,
        env=ctx.env,
    )
    if inst.returncode != 0:
        return check("build_ok", False, last_lines(inst.stderr or inst.stdout)), ctx
    vite_js = tree / VITE_BIN
    if not vite_js.is_file():
        return check("build_ok", False, "vite binary missing after install"), ctx
    built = run_in_sandbox(
        "build",
        ["node", str(VITE_BIN), "build", "--config", "vite.config.mjs"],
        tree=tree,
        cache=NPM_CACHE,
        home=home,
        env=ctx.env,
    )
    if built.returncode != 0:
        err = (built.stderr or built.stdout or "").lower()
        if "sandbox" in err and "fail" in err:
            return check("build_ok", False, "sandbox unavailable"), ctx
        return check("build_ok", False, last_lines(built.stderr or built.stdout)), ctx
    dist = tree / "dist"
    if not dist.is_dir():
        return check("build_ok", False, "vite build exited 0 but dist/ is missing"), ctx
    dest = web / "dist"
    if dest.exists():
        shutil.rmtree(dest)
    shutil.copytree(dist, dest)
    return check("build_ok", True, "ok"), ctx


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
        self.styles: list[str] = []
        self.style_blocks: list[str] = []
        self._in_style = False
        self._style_buf: list[str] = []

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
        if "style" in ad:
            self.styles.append(ad["style"])
        if tag in {"link", "script", "iframe", "source", "img"} and "href" in ad and tag != "a":
            self.hrefs.append(ad["href"])
        if tag == "style":
            self._in_style = True
            self._style_buf = []

    def handle_endtag(self, tag: str) -> None:
        if tag == "style" and self._in_style:
            self.style_blocks.append("".join(self._style_buf))
            self._in_style = False
            self._style_buf = []

    def handle_data(self, data: str) -> None:
        if self._in_style:
            self._style_buf.append(data)


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
    for m in re.finditer(r"@import\s+url\(\s*(['\"]?)([^)'\"]+)\1\s*\)", text, flags=re.I):
        found.append(m.group(2).strip())
    for m in re.finditer(r"@import\s+(['\"])([^'\"]+)\1", text, flags=re.I):
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
    s = url.strip().split("#", 1)[0].split("?", 1)[0]
    return unquote(s)


def url_rejected(url: str) -> bool:
    raw = url.strip()
    if "\x00" in raw or "\\" in raw:
        return True
    if raw.startswith("//"):
        return True
    lower = raw.lower()
    if "%00" in lower or "%5c" in lower:
        return True
    if "%2e" in lower or "%2f" in lower:
        return True
    decoded = unquote(raw)
    if "\x00" in decoded or "\\" in decoded:
        return True
    return False


def resolve_in_dist(dist: Path, from_file: Path, url: str) -> Path | None:
    if url_rejected(url):
        return Path("/__rejected__")
    raw = strip_url(url)
    if is_ignored(raw):
        return None
    while raw.startswith("./"):
        raw = raw[2:]
    dist_real = dist.resolve()
    if raw.startswith("/"):
        joined = posixpath.normpath("/" + raw.lstrip("/"))
        if joined.startswith("/..") or joined == "/..":
            return Path("/__outside_dist__")
        target = dist_real.joinpath(*joined.lstrip("/").split("/")) if joined != "/" else dist_real
    else:
        start = from_file.parent.resolve()
        joined = posixpath.normpath(str(Path(raw).as_posix()))
        target = start.joinpath(*joined.split("/")) if joined not in (".", "") else start
    try:
        if target.exists() or target.is_symlink():
            real = target.resolve()
        else:
            real = target
    except OSError:
        return Path("/__unresolved__")
    prefix = str(dist_real) + os.sep
    real_s = str(real)
    if not (real_s == str(dist_real) or real_s.startswith(prefix)):
        return Path("/__outside_dist__")
    if target.is_symlink():
        try:
            if not str(target.resolve()).startswith(prefix) and str(target.resolve()) != str(dist_real):
                return Path("/__outside_dist__")
        except OSError:
            return Path("/__outside_dist__")
    candidates = [target]
    if target.suffix == "":
        candidates.extend([target / "index.html", Path(str(target) + ".html")])
    for c in candidates:
        if c.is_file() and not c.is_symlink():
            try:
                cr = c.resolve()
            except OSError:
                continue
            if str(cr) == str(dist_real) or str(cr).startswith(prefix):
                return cr
        if c.is_file():
            return Path("/__outside_dist__")
    return target


def visible_text(html: str) -> str:
    stripped = re.sub(r"<!--.*?-->", " ", html, flags=re.S)
    stripped = re.sub(r"<script\b[^>]*>[\s\S]*?</script>", " ", stripped, flags=re.I)
    stripped = re.sub(r"<style\b[^>]*>[\s\S]*?</style>", " ", stripped, flags=re.I)
    stripped = re.sub(r"<template\b[^>]*>[\s\S]*?</template>", " ", stripped, flags=re.I)
    stripped = re.sub(r"<noscript\b[^>]*>[\s\S]*?</noscript>", " ", stripped, flags=re.I)
    stripped = re.sub(r"<[^>]+>", " ", stripped)
    stripped = unicodedata.normalize("NFC", stripped)
    stripped = re.sub(r"\s+", " ", stripped).strip().casefold()
    return stripped


def norm_ws(s: str) -> str:
    s = unicodedata.normalize("NFC", str(s or ""))
    return re.sub(r"\s+", " ", s).strip().casefold()


def phrase_in(blob: str, name: str) -> bool:
    n = norm_ws(name)
    if not n:
        return False
    return re.search(r"(?<!\w)" + re.escape(n) + r"(?!\w)", blob) is not None


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
        while raw.startswith("./"):
            raw = raw[2:]
        referenced.add(raw)
        referenced.add("/" + raw.lstrip("/"))
        referenced.add(raw.lstrip("/"))
        parsed = urlparse(raw)
        if parsed.path:
            referenced.add(parsed.path)
            referenced.add(parsed.path.lstrip("/"))

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
        css_from = refs.styles + refs.style_blocks + css_urls(html)
        for url in css_from:
            for u in css_urls(url) if "url(" in url or "@import" in url.lower() else [url]:
                if is_ignored(strip_url(u)):
                    continue
                note_ref(u)
                resolved = resolve_in_dist(dist, html_file, u)
                if resolved is not None and not resolved.is_file():
                    broken.append(f"{html_file.relative_to(dist_real)} css -> {u}")

    if dist.is_dir():
        for css in dist.rglob("*.css"):
            if css.is_file():
                css_real = css.resolve()
                for url in css_urls(css.read_text(encoding="utf-8", errors="replace")):
                    if is_ignored(strip_url(url)):
                        continue
                    note_ref(url)
                    resolved = resolve_in_dist(dist, css_real, url)
                    if resolved is not None and not resolved.is_file():
                        try:
                            rel = str(css_real.relative_to(dist_real))
                        except ValueError:
                            rel = css.name
                        broken.append(f"{rel} css -> {url}")

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
    shorts = [n for n in [company, *products] if 0 < len(n) < 3]
    if not company or not phrase_in(blob, company):
        missing.append(f"company.name {company!r}")
    found_products = [n for n in products if phrase_in(blob, n)]
    if len(found_products) < 3:
        missing.append(
            f"need ≥3 product names, found {len(found_products)} of {len(products)}: "
            + ", ".join(found_products or ["(none)"])
        )
    ok = not missing
    detail = "ok" if ok else "; ".join(missing)
    if shorts:
        amb = ", ".join(f"ambiguous short name: {s}" for s in shorts)
        detail = f"{detail}; {amb}" if detail != "ok" else f"ok; {amb}"
    return check("copy_grounded", ok, detail)


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


def lighthouse_check(workdir: Path, ctx: BuildCtx) -> dict:
    if lighthouse_skip_honoured():
        return check("lighthouse≥85", True, "skipped: WEBSITE_GATE_SKIP_LIGHTHOUSE=1")
    tree = ctx.tree
    if tree is None or not (tree / VITE_BIN).is_file():
        return check("lighthouse≥85", False, "chrome launch failed: preview tree missing")
    port = free_port()
    devtools_port = free_port()
    chrome_dir = tree / "lhprofile"
    chrome_dir.mkdir(exist_ok=True)
    out_json = tree / "lh.json"
    chrome_flags = (
        f"--headless=new --no-sandbox --disable-gpu --disable-breakpad "
        f"--user-data-dir={chrome_dir}"
    )
    preview_cmd = [
        "node",
        str(VITE_BIN),
        "preview",
        "--port",
        str(port),
        "--strictPort",
        "--host",
        "127.0.0.1",
    ]
    if not SANDBOX_EXEC.is_file():
        return check("lighthouse≥85", False, "sandbox unavailable")
    env = ctx.env or gate_env(ctx.home or tree, NPM_CACHE)
    home = ctx.home or tree
    tmpdir = Path(env.get("TMPDIR") or (home / "tmp"))
    profile = tree / ".seatbelt-preview.sb"
    try:
        profile.write_text(
            seatbelt_profile(
                "preview",
                tree,
                NPM_CACHE,
                home,
                preview_port=port,
                devtools_port=devtools_port,
                tmpdir=tmpdir,
            ),
            encoding="utf-8",
        )
    except FileNotFoundError:
        return check("lighthouse≥85", False, "sandbox unavailable")
    preview = subprocess.Popen(
        [str(SANDBOX_EXEC), "-f", str(profile), *preview_cmd],
        cwd=tree,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        start_new_session=True,
    )
    try:
        if not wait_port(port, timeout=30):
            err = ""
            if preview.stderr:
                try:
                    err = preview.stderr.read()[-2000:]
                except Exception:
                    err = ""
            return check("lighthouse≥85", False, f"chrome launch failed: vite preview did not bind :{port} {err}".strip())
        lh_cmd = [
            "lighthouse",
            f"http://127.0.0.1:{port}/",
            "--only-categories=performance,accessibility",
            "--output=json",
            f"--output-path={out_json}",
            "--port",
            str(devtools_port),
            f"--chrome-flags={chrome_flags}",
            "--quiet",
        ]
        try:
            lh = run_in_sandbox(
                "lighthouse",
                lh_cmd,
                tree=tree,
                cache=NPM_CACHE,
                home=home,
                env=env,
                timeout=120,
                preview_port=port,
                devtools_port=devtools_port,
            )
        except subprocess.TimeoutExpired:
            return check("lighthouse≥85", False, "lighthouse timed out")
        combined = (lh.stderr or "") + (lh.stdout or "")
        if lh.returncode != 0 or not out_json.is_file():
            if "chrome" in combined.lower() or "chromium" in combined.lower() or "launch" in combined.lower():
                return check("lighthouse≥85", False, f"chrome launch failed: {last_lines(combined, 8)}")
            return check("lighthouse≥85", False, last_lines(combined or "lighthouse failed", 40))
        try:
            data = json.loads(out_json.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            return check("lighthouse≥85", False, "chrome launch failed: lighthouse json unparsable")
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


def cleanup_ctx(ctx: BuildCtx) -> None:
    if ctx.tree and ctx.tree.exists():
        shutil.rmtree(ctx.tree, ignore_errors=True)


def run_checks(workdir: Path, loop_run_id: str = "run") -> list[dict]:
    brand = brand_assets(workdir)
    built, ctx = run_build(workdir / "website", loop_run_id)
    try:
        if not built["passed"]:
            return [
                brand,
                built,
                check("links_ok", False, SKIP_BUILD),
                check("copy_grounded", False, SKIP_BUILD),
                check("lighthouse≥85", False, SKIP_BUILD),
            ]
        try:
            lh = lighthouse_check(workdir, ctx)
        except Exception as exc:
            lh = check("lighthouse≥85", False, f"chrome launch failed: {exc}")
        return [
            brand,
            built,
            links_ok(workdir),
            copy_grounded(workdir),
            lh,
        ]
    finally:
        cleanup_ctx(ctx)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="website_gate.py")
    parser.add_argument("--workdir", required=True)
    parser.add_argument("--db", required=True)
    parser.add_argument("--loop-run-id", required=True)
    args = parser.parse_args(argv)
    checks = run_checks(Path(args.workdir), args.loop_run_id)
    print(json.dumps(checks, ensure_ascii=False))
    return 0 if checks and all(c["passed"] for c in checks) else 1


if __name__ == "__main__":
    sys.exit(main())
