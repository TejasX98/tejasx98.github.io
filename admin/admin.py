#!/usr/bin/env python3
"""
Portfolio Admin — a local-only editor for your portfolio site.

    python admin/admin.py          (or double-click start-admin.bat on Windows)

Opens http://127.0.0.1:8321 in your browser. You can add/edit/remove projects,
publications and media, preview the site, then press "Publish" to commit and
push to GitHub, which rebuilds the live site.

Security: listens on 127.0.0.1 only (not reachable from other devices), checks
the Host header (blocks DNS-rebinding), and requires a random per-session token
on every change. No passwords or GitHub tokens are stored by this tool — git
uses your normal GitHub sign-in (Git Credential Manager).
"""
import hmac, json, os, re, secrets, shutil, subprocess, sys, tempfile, threading, time, webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlparse

try:
    import yaml
except ImportError:
    sys.exit("PyYAML is missing. Run:  python -m pip install -r admin/requirements.txt")
try:
    from PIL import Image, ImageOps
except ImportError:
    sys.exit("Pillow is missing. Run:  python -m pip install -r admin/requirements.txt")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ADMIN = os.path.join(ROOT, "admin")
UI = os.path.join(ADMIN, "ui")
SITE = os.path.join(ROOT, "site")
CONTENT = os.path.join(SITE, "content")
MEDIA = os.path.join(SITE, "media")
TMP = os.path.join(ROOT, ".admin-tmp")
HOST = "127.0.0.1"
PORT = int(os.environ.get("PORTFOLIO_ADMIN_PORT", "8321"))
TOKEN = secrets.token_urlsafe(32)
FFMPEG = shutil.which("ffmpeg")
LOCK = threading.Lock()

MAX_UPLOAD = 400 * 1024 * 1024      # what we accept from the browser
GITHUB_HARD_LIMIT = 95 * 1024 * 1024 # GitHub rejects files over 100 MB
WARN_SIZE = 25 * 1024 * 1024
IMG_EXT = {".jpg", ".jpeg", ".png", ".webp", ".gif"}
VID_EXT = {".mp4", ".webm", ".mov", ".m4v"}
PDF_EXT = {".pdf"}
SECRET_NAMES = re.compile(r"(^\.env|\.pem$|\.key$|\.p12$|\.pfx$|id_rsa|id_ed25519|credentials|secret|\.kdbx$)", re.I)

HEADERS = {
    "projects.yml": "# Projects — edited by the admin tool (admin/). You can also edit by hand.\n"
                    "# Order on the page = order here. hidden: true = draft (not shown on the live site).\n\n",
    "publications.yml": "# Publications — edited by the admin tool. hidden: true = not shown.\n\n",
}
PROJECT_KEYS = ["id", "title", "category", "date", "summary", "role", "team", "tags",
                "featured", "hidden", "cover", "details", "links", "media"]
PUB_KEYS = ["title", "authors", "venue", "year", "type", "url", "file", "hidden"]


class UserError(Exception):
    """A problem we explain to the user (shown as a message, not a crash)."""


# ---------------------------------------------------------------- YAML I/O
class _Dumper(yaml.SafeDumper):
    pass


def _str(dumper, s):
    if "\n" in s:
        return dumper.represent_scalar("tag:yaml.org,2002:str", s.rstrip() + "\n", style="|")
    return dumper.represent_scalar("tag:yaml.org,2002:str", s)


_Dumper.add_representer(str, _str)


def read_yaml(name, default):
    path = os.path.join(CONTENT, name)
    if not os.path.exists(path):
        return default
    with open(path, encoding="utf-8") as f:
        data = yaml.safe_load(f)
    return default if data is None else data


def atomic_write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".tmp-")
    with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    os.replace(tmp, path)


def write_yaml(name, data):
    body = yaml.dump(data, Dumper=_Dumper, sort_keys=False, allow_unicode=True, width=1000, default_flow_style=False)
    text = HEADERS.get(name, "") + body
    yaml.safe_load(text)  # sanity check before touching the file
    atomic_write(os.path.join(CONTENT, name), text)


# ---------------------------------------------------------------- validation
def slugify(s, maxlen=60):
    s = re.sub(r"[^a-z0-9]+", "-", str(s or "").lower()).strip("-")
    return s[:maxlen].strip("-")


def text(v, maxlen=20000):
    if v is None:
        return ""
    if not isinstance(v, (str, int, float)):
        raise UserError("Unexpected value in form.")
    return str(v).strip()[:maxlen]


def url_ok(u):
    u = (u or "").strip()
    if re.match(r"^(https?://|mailto:)", u, re.I):
        return True
    if re.match(r"^[a-z][a-z0-9+.-]*:", u, re.I) or u.startswith("//") or u.startswith("/") or ".." in u:
        return False
    return True  # relative link inside the site (e.g. media/... or project.html?id=...)


def media_path_ok(p):
    """True if p is a file inside site/media."""
    if not p or not isinstance(p, str) or not p.startswith("media/") or ".." in p or "\\" in p:
        return False
    full = os.path.realpath(os.path.join(SITE, p))
    return full.startswith(os.path.realpath(MEDIA) + os.sep) and os.path.isfile(full)


def clean_project(p):
    if not isinstance(p, dict):
        raise UserError("Bad project data.")
    title = text(p.get("title"), 200)
    if not title:
        raise UserError("Give the project a title.")
    out = {"id": slugify(p.get("id") or title), "title": title}
    if not out["id"]:
        raise UserError("The project ID needs letters or numbers.")
    for k, n in (("category", 60), ("date", 60), ("summary", 600), ("role", 400), ("team", 300)):
        v = text(p.get(k), n)
        if v:
            out[k] = v
    tags = p.get("tags") or []
    if isinstance(tags, str):
        tags = tags.split(",")
    tags = [text(t, 60) for t in tags if text(t, 60)]
    if tags:
        out["tags"] = tags[:20]
    if p.get("featured"):
        out["featured"] = True
    if p.get("hidden"):
        out["hidden"] = True
    cover = text(p.get("cover"), 300)
    if cover:
        if not media_path_ok(cover):
            raise UserError("The cover image file wasn't found: " + cover)
        out["cover"] = cover
    details = text(p.get("details"), 20000)
    if details:
        out["details"] = details
    links = []
    for l in p.get("links") or []:
        label, url = text(l.get("label"), 80), text(l.get("url"), 500)
        if not label and not url:
            continue
        if not label or not url:
            raise UserError("Each link needs both a label and an address.")
        if not url_ok(url):
            raise UserError("This link isn't allowed (use https://… or a file in media/): " + url)
        links.append({"label": label, "url": url})
    out["links"] = links
    media = []
    for m in p.get("media") or []:
        t = m.get("type")
        cap = text(m.get("caption"), 200)
        if t == "youtube":
            vid = text(m.get("id"), 20)
            if not re.fullmatch(r"[\w-]{6,20}", vid):
                raise UserError("That YouTube video ID doesn't look right: " + vid)
            item = {"type": "youtube", "id": vid}
        elif t in ("image", "video", "pdf"):
            src = text(m.get("src"), 300)
            if not media_path_ok(src):
                raise UserError("A media file is missing: " + src)
            item = {"type": t, "src": src}
            poster = text(m.get("poster"), 300)
            if t == "video" and poster and media_path_ok(poster):
                item["poster"] = poster
        else:
            raise UserError("Unknown media type.")
        if cap:
            item["caption"] = cap
        media.append(item)
    out["media"] = media
    return {k: out[k] for k in PROJECT_KEYS if k in out}


def clean_pub(p):
    title = text(p.get("title"), 300)
    if not title:
        raise UserError("Each publication needs a title.")
    out = {"title": title}
    for k, n in (("authors", 300), ("venue", 300), ("year", 20), ("type", 60)):
        v = text(p.get(k), n)
        if v:
            out[k] = v
    url = text(p.get("url"), 500)
    if url:
        if not re.match(r"^https?://", url, re.I):
            raise UserError("Publication links must start with https:// — " + url)
        out["url"] = url
    f = text(p.get("file"), 300)
    if f:
        if not media_path_ok(f):
            raise UserError("Publication PDF not found: " + f)
        out["file"] = f
    if p.get("hidden"):
        out["hidden"] = True
    return {k: out[k] for k in PUB_KEYS if k in out}


# ---------------------------------------------------------------- site.yml helpers
def set_site_key(key, value):
    """Set or remove a top-level `key: value` line in site.yml, keeping comments."""
    path = os.path.join(CONTENT, "site.yml")
    with open(path, encoding="utf-8") as f:
        lines = f.read().split("\n")
    pat = re.compile(r"^" + re.escape(key) + r":")
    idx = next((i for i, l in enumerate(lines) if pat.match(l)), None)
    new = None if value is None else f"{key}: {value}"
    if idx is not None:
        if new is None:
            lines.pop(idx)
        else:
            lines[idx] = new
    elif new is not None:
        anchor = next((i for i, l in enumerate(lines) if l.startswith("photo:")), None)
        lines.insert(anchor + 1 if anchor is not None else len(lines), new)
    out = "\n".join(lines)
    yaml.safe_load(out)
    atomic_write(path, out)
    write_seo()


def _attr(s):
    return (str(s or "").replace("&", "&amp;").replace('"', "&quot;").replace("<", "&lt;").replace(">", "&gt;"))


def write_seo():
    """Put title/description/social-preview tags into index.html (link previews can't run JavaScript)."""
    site = read_yaml("site.yml", {})
    name, headline = site.get("name", ""), site.get("headline", "")
    desc = re.sub(r"\s+", " ", str(site.get("tagline", ""))).strip()
    if len(desc) > 200:
        desc = desc[:200].rsplit(" ", 1)[0].rstrip(",.;") + "…"
    title = f"{name} — {headline}" if headline else name
    tags = [f"  <title>{_attr(title)}</title>",
            f'  <meta name="description" content="{_attr(desc)}">',
            f'  <meta property="og:type" content="website">',
            f'  <meta property="og:title" content="{_attr(title)}">',
            f'  <meta property="og:description" content="{_attr(desc)}">']
    base = str(site.get("url") or "").strip()
    if re.match(r"^https://", base):
        base = base.rstrip("/") + "/"
        tags.append(f'  <meta property="og:url" content="{_attr(base)}">')
        tags.append(f'  <link rel="canonical" href="{_attr(base)}">')
        if site.get("photo"):
            tags.append(f'  <meta property="og:image" content="{_attr(base + str(site["photo"]))}">')
    path = os.path.join(SITE, "index.html")
    with open(path, encoding="utf-8") as f:
        html = f.read()
    block = "  <!-- seo:start (written by the admin tool from content/site.yml) -->\n" + "\n".join(tags) + "\n  <!-- seo:end -->"
    html, n = re.subn(r"  <!-- seo:start.*?<!-- seo:end -->", lambda m: block, html, flags=re.S)
    if n:
        atomic_write(path, html)


# ---------------------------------------------------------------- media
def unique_name(folder, name):
    stem, ext = os.path.splitext(name)
    cand, i = name, 2
    while os.path.exists(os.path.join(folder, cand)):
        cand, i = f"{stem}-{i}{ext}", i + 1
    return cand


def run_ffmpeg(args):
    r = subprocess.run([FFMPEG, "-v", "error", "-y"] + args, capture_output=True, text=True, timeout=1800)
    if r.returncode:
        raise UserError("Video conversion failed: " + r.stderr[-400:])


def process_upload(tmp_path, folder_rel, filename, kind=None):
    """Turn an uploaded temp file into a clean media file. Returns dict for the UI."""
    folder = os.path.join(SITE, folder_rel)
    os.makedirs(folder, exist_ok=True)
    stem, ext = os.path.splitext(filename)
    ext = ext.lower()
    stem = slugify(stem, 50) or "file"
    size = os.path.getsize(tmp_path)
    warnings = []

    if ext in (".heic", ".heif"):
        raise UserError("HEIC photos aren't supported by browsers. Export as JPG first "
                        "(iPhone: Settings → Camera → Formats → Most Compatible).")

    if ext in IMG_EXT:
        try:
            with Image.open(tmp_path) as im:
                im.verify()
            im = Image.open(tmp_path)
        except Exception:
            raise UserError(f"{filename} isn't a readable image.")
        if ext == ".gif" and getattr(im, "is_animated", False):
            name = unique_name(folder, stem + ".gif")
            shutil.copyfile(tmp_path, os.path.join(folder, name))
        else:
            im = ImageOps.exif_transpose(im)
            im.thumbnail((1920, 1920))
            has_alpha = im.mode in ("RGBA", "LA") or (im.mode == "P" and "transparency" in im.info)
            if ext == ".png" and has_alpha:
                name = unique_name(folder, stem + ".png")
                im.save(os.path.join(folder, name), optimize=True)          # metadata not copied
            else:
                name = unique_name(folder, stem + ".jpg")
                im.convert("RGB").save(os.path.join(folder, name), quality=84, optimize=True, progressive=True)
        if kind == "photo":
            final = os.path.join(folder, "photo.jpg")
            Image.open(os.path.join(folder, name)).convert("RGB").save(final, quality=88)
            if name != "photo.jpg":
                os.remove(os.path.join(folder, name))
            name = "photo.jpg"
        return {"type": "image", "src": f"{folder_rel}/{name}", "warnings": warnings}

    if ext in VID_EXT:
        if FFMPEG:
            name = unique_name(folder, stem + ".mp4")
            out = os.path.join(folder, name)
            run_ffmpeg(["-i", tmp_path, "-map_metadata", "-1", "-vf", "scale='min(1280,iw)':-2",
                        "-c:v", "libx264", "-preset", "veryfast", "-crf", "28", "-pix_fmt", "yuv420p",
                        "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", out])
            poster = name[:-4] + "-poster.jpg"
            run_ffmpeg(["-ss", "1", "-i", out, "-frames:v", "1", "-q:v", "4", os.path.join(folder, poster)])
            res = {"type": "video", "src": f"{folder_rel}/{name}", "poster": f"{folder_rel}/{poster}"}
        else:
            if ext not in (".mp4", ".webm"):
                raise UserError("Only .mp4 or .webm videos can be used as-is. Install ffmpeg to convert other formats, or upload to YouTube.")
            name = unique_name(folder, stem + ext)
            shutil.copyfile(tmp_path, os.path.join(folder, name))
            res = {"type": "video", "src": f"{folder_rel}/{name}"}
            warnings.append("Video copied without compression (ffmpeg not installed).")
        final_size = os.path.getsize(os.path.join(SITE, res["src"]))
        if final_size > GITHUB_HARD_LIMIT:
            os.remove(os.path.join(SITE, res["src"]))
            raise UserError(f"That video is {final_size // 1048576} MB — GitHub's limit is 100 MB. "
                            "Upload it to YouTube (Unlisted is fine) and add it with 'Add YouTube video'.")
        if final_size > WARN_SIZE:
            warnings.append(f"Video is {final_size // 1048576} MB. It will work, but YouTube keeps the site faster.")
        res["warnings"] = warnings
        return res

    if ext in PDF_EXT:
        with open(tmp_path, "rb") as f:
            if f.read(5) != b"%PDF-":
                raise UserError(f"{filename} isn't a valid PDF.")
        if size > 30 * 1048576:
            raise UserError("PDF is over 30 MB — compress it first (e.g. ilovepdf.com → Compress).")
        name = "CV.pdf" if kind == "cv" else unique_name(folder, stem + ".pdf")
        shutil.copyfile(tmp_path, os.path.join(folder, name))
        warnings.append("Check the PDF doesn't show your phone number or home address before publishing.")
        return {"type": "pdf", "src": f"{folder_rel}/{name}", "warnings": warnings}

    raise UserError(f"{filename}: file type not allowed. Use JPG/PNG/WebP/GIF images, MP4 video or PDF.")


def referenced_media():
    refs = set()

    def walk(x):
        if isinstance(x, dict):
            for v in x.values():
                walk(v)
        elif isinstance(x, list):
            for v in x:
                walk(v)
        elif isinstance(x, str) and x.startswith("media/"):
            refs.add(x)

    walk(read_yaml("projects.yml", []))
    walk(read_yaml("publications.yml", []))
    walk(read_yaml("site.yml", {}))
    return refs


def unused_media():
    refs = referenced_media()
    out = []
    for base in ("projects", "publications"):
        root = os.path.join(MEDIA, base)
        for dp, _, files in os.walk(root):
            for fn in files:
                if fn.startswith(".") and fn != ".gitkeep":
                    continue
                if fn == ".gitkeep":
                    continue
                rel = os.path.relpath(os.path.join(dp, fn), SITE).replace(os.sep, "/")
                if rel not in refs:
                    out.append(rel)
    return sorted(out)


# ---------------------------------------------------------------- git
def git(*args, timeout=60):
    try:
        r = subprocess.run(["git", "-C", ROOT] + list(args), capture_output=True, text=True,
                           timeout=timeout, stdin=subprocess.DEVNULL)
    except FileNotFoundError:
        raise UserError("Git isn't installed. Install it from https://git-scm.com and restart the admin tool.")
    except subprocess.TimeoutExpired:
        raise UserError("Git took too long. Check your internet connection and try again.")
    return r.returncode, (r.stdout + r.stderr).strip()


def git_info():
    if not shutil.which("git"):
        return {"ok": False, "reason": "Git isn't installed (https://git-scm.com)."}
    code, _ = git("rev-parse", "--is-inside-work-tree")
    if code:
        return {"ok": False, "reason": "This folder isn't connected to GitHub yet — see README step 2."}
    _, branch = git("rev-parse", "--abbrev-ref", "HEAD")
    code, remote = git("remote", "get-url", "origin")
    _, status = git("status", "--porcelain=v1", "--untracked-files=all", "--", "site")
    changes = [l for l in status.splitlines() if l.strip()]
    code2, ahead = git("rev-list", "--count", "@{u}..HEAD")
    return {"ok": True, "branch": branch, "remote": remote if code == 0 else "",
            "changes": changes[:200], "change_count": len(changes),
            "unpushed": int(ahead) if code2 == 0 and ahead.isdigit() else 0}


def preflight():
    """Checks before publishing. Returns (errors, warnings)."""
    errors, warnings = [], []
    for name in ("site.yml", "projects.yml", "publications.yml"):
        try:
            read_yaml(name, None)
        except yaml.YAMLError as e:
            errors.append(f"{name} has a formatting error: {e}")
    for dp, dirs, files in os.walk(SITE):
        for fn in files:
            full = os.path.join(dp, fn)
            rel = os.path.relpath(full, SITE)
            sz = os.path.getsize(full)
            if sz > GITHUB_HARD_LIMIT:
                errors.append(f"{rel} is {sz // 1048576} MB — over GitHub's 100 MB limit.")
            elif sz > 40 * 1048576:
                warnings.append(f"{rel} is {sz // 1048576} MB.")
            if SECRET_NAMES.search(fn):
                errors.append(f"{rel} looks like a private key/secret file — remove it from site/.")
    return errors, warnings


def publish(message):
    info = git_info()
    if not info["ok"]:
        raise UserError(info["reason"])
    errors, warnings = preflight()
    if errors:
        raise UserError("Not published:\n• " + "\n• ".join(errors))
    log = []
    code, out = git("add", "-A", "--", "site")
    log.append("$ git add site\n" + out)
    if code:
        raise UserError("git add failed:\n" + out)
    code, out = git("diff", "--cached", "--quiet")
    if code == 0 and info["unpushed"] == 0:
        return {"log": "Nothing to publish — the live site is already up to date.", "warnings": warnings}
    if code != 0:
        msg = (message or "Update portfolio content").strip()[:200]
        code, out = git("commit", "-m", msg)
        log.append("$ git commit\n" + out)
        if code:
            if "user.email" in out or "Please tell me who you are" in out:
                raise UserError('Git doesn\'t know who you are yet. In a terminal run:\n'
                                'git config --global user.name "Your Name"\n'
                                'git config --global user.email "you@example.com"')
            raise UserError("git commit failed:\n" + out)
    code, out = git("push", timeout=300)
    log.append("$ git push\n" + out)
    if code:
        if "rejected" in out or "fetch first" in out or "non-fast-forward" in out:
            raise UserError("GitHub has changes you don't have locally (maybe you edited on github.com). "
                            "Press 'Get latest from GitHub', then Publish again.\n\n" + out)
        if "Authentication" in out or "could not read Username" in out or "403" in out:
            raise UserError("GitHub sign-in needed. Open a terminal in this folder and run  git push  once — "
                            "a GitHub sign-in window will appear. Then Publish again.\n\n" + out)
        raise UserError("git push failed:\n" + out)
    log.append("Published. GitHub rebuilds the live site in about a minute.")
    return {"log": "\n\n".join(log), "warnings": warnings}


# ---------------------------------------------------------------- state
def state():
    projects = read_yaml("projects.yml", [])
    pubs = read_yaml("publications.yml", [])
    with open(os.path.join(CONTENT, "site.yml"), encoding="utf-8") as f:
        site_text = f.read()
    site = yaml.safe_load(site_text) or {}
    cats = sorted({p.get("category") for p in projects if isinstance(p, dict) and p.get("category")})
    return {"projects": projects, "publications": pubs, "site_text": site_text,
            "site": {"photo": site.get("photo"), "cv": site.get("cv"), "url": site.get("url"), "name": site.get("name")},
            "categories": cats, "ffmpeg": bool(FFMPEG)}


def move_project_media(old, new, project):
    src, dst = os.path.join(MEDIA, "projects", old), os.path.join(MEDIA, "projects", new)
    if os.path.isdir(src):
        if os.path.exists(dst):
            raise UserError(f"A media folder named '{new}' already exists. Pick a different ID.")
        shutil.move(src, dst)
    pre_old, pre_new = f"media/projects/{old}/", f"media/projects/{new}/"

    def fix(x):
        if isinstance(x, str) and x.startswith(pre_old):
            return pre_new + x[len(pre_old):]
        if isinstance(x, list):
            return [fix(v) for v in x]
        if isinstance(x, dict):
            return {k: fix(v) for k, v in x.items()}
        return x
    return fix(project)


def api_save_project(body):
    original = body.get("original_id")
    raw = body.get("project") or {}
    projects = read_yaml("projects.yml", [])
    ids = [p.get("id") for p in projects]
    new_id = slugify(raw.get("id") or raw.get("title"))
    if original and original in ids:
        if new_id != original:
            if new_id in ids:
                raise UserError(f"Another project already uses the ID '{new_id}'.")
            raw = move_project_media(original, new_id, dict(raw, id=new_id))
        proj = clean_project(dict(raw, id=new_id))
        projects[ids.index(original)] = proj
    else:
        upload_id = slugify(body.get("upload_id") or "")
        if new_id in ids:
            raise UserError(f"Another project already uses the ID '{new_id}'. Change the ID.")
        if upload_id and upload_id != new_id:
            raw = move_project_media(upload_id, new_id, dict(raw, id=new_id))
        proj = clean_project(dict(raw, id=new_id))
        projects.insert(0, proj)
    write_yaml("projects.yml", projects)
    return {"saved_id": proj["id"]}


def api_delete_project(body):
    pid = body.get("id")
    projects = read_yaml("projects.yml", [])
    if pid not in [p.get("id") for p in projects]:
        raise UserError("Project not found.")
    projects = [p for p in projects if p.get("id") != pid]
    write_yaml("projects.yml", projects)
    if body.get("delete_media"):
        folder = os.path.realpath(os.path.join(MEDIA, "projects", slugify(pid)))
        if folder.startswith(os.path.realpath(os.path.join(MEDIA, "projects")) + os.sep) and os.path.isdir(folder):
            shutil.rmtree(folder)
    return {}


def api_reorder(body):
    order = body.get("ids") or []
    projects = read_yaml("projects.yml", [])
    by_id = {p.get("id"): p for p in projects}
    if sorted(order) != sorted(by_id):
        raise UserError("The project list changed — reload the page.")
    write_yaml("projects.yml", [by_id[i] for i in order])
    return {}


def api_save_pubs(body):
    pubs = [clean_pub(p) for p in body.get("publications") or []]
    write_yaml("publications.yml", pubs)
    return {}


def api_save_site(body):
    txt = body.get("text") or ""
    try:
        data = yaml.safe_load(txt)
    except yaml.YAMLError as e:
        mark = getattr(e, "problem_mark", None)
        where = f" (line {mark.line + 1})" if mark else ""
        raise UserError(f"Formatting error{where}: {getattr(e, 'problem', e)}. Check spaces and colons.")
    if not isinstance(data, dict) or not data.get("name"):
        raise UserError("site.yml must at least have  name: Your Name")
    for key in ("photo", "cv"):
        v = data.get(key)
        if v and not media_path_ok(v):
            raise UserError(f"{key}: file not found — {v}")
    atomic_write(os.path.join(CONTENT, "site.yml"), txt if txt.endswith("\n") else txt + "\n")
    write_seo()
    return {}


def api_cleanup(body):
    files = unused_media()
    if body.get("delete"):
        for rel in files:
            full = os.path.realpath(os.path.join(SITE, rel))
            if full.startswith(os.path.realpath(MEDIA) + os.sep):
                os.remove(full)
        for base in ("projects", "publications"):
            root = os.path.join(MEDIA, base)
            for dp, dirs, fs in sorted(os.walk(root), reverse=True):
                if dp != root and not os.listdir(dp):
                    os.rmdir(dp)
    return {"files": files}


def api_pull(_):
    info = git_info()
    if not info["ok"]:
        raise UserError(info["reason"])
    code, out = git("pull", "--ff-only", timeout=180)
    if code:
        raise UserError("Couldn't get the latest version:\n" + out)
    return {"log": out}


ROUTES = {
    "/api/projects/save": api_save_project,
    "/api/projects/delete": api_delete_project,
    "/api/projects/reorder": api_reorder,
    "/api/publications/save": api_save_pubs,
    "/api/site/save": api_save_site,
    "/api/cleanup": api_cleanup,
    "/api/pull": api_pull,
    "/api/publish": lambda b: publish(b.get("message")),
}

MIME = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
        ".yml": "text/yaml; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".mp4": "video/mp4", ".webm": "video/webm",
        ".pdf": "application/pdf", ".json": "application/json", ".txt": "text/plain; charset=utf-8", ".ico": "image/x-icon"}

ADMIN_CSP = ("default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; "
             "font-src https://fonts.gstatic.com; img-src 'self' data: blob:; media-src 'self' blob:; "
             "frame-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")


# ---------------------------------------------------------------- HTTP
class Handler(BaseHTTPRequestHandler):
    server_version = "PortfolioAdmin"
    sys_version = ""

    def log_message(self, fmt, *args):
        if os.environ.get("PORTFOLIO_ADMIN_DEBUG"):
            super().log_message(fmt, *args)

    # -- guards
    def host_ok(self):
        port = self.server.server_address[1]
        return self.headers.get("Host", "") in (f"127.0.0.1:{port}", f"localhost:{port}")

    def write_ok(self):
        tok = self.headers.get("X-Admin-Token", "")
        if not hmac.compare_digest(tok, TOKEN):
            return False
        origin = self.headers.get("Origin")
        port = self.server.server_address[1]
        return origin in (None, f"http://127.0.0.1:{port}", f"http://localhost:{port}")

    def send(self, code, body, ctype="application/json", extra=None):
        data = body if isinstance(body, bytes) else json.dumps(body).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def send_file(self, full, extra=None):
        ext = os.path.splitext(full)[1].lower()
        size = os.path.getsize(full)
        rng = self.headers.get("Range")
        m = re.match(r"bytes=(\d*)-(\d*)$", rng or "")
        with open(full, "rb") as f:
            if m and (m.group(1) or m.group(2)):          # video seeking needs range requests
                if m.group(1):
                    start = int(m.group(1)); end = int(m.group(2)) if m.group(2) else size - 1
                else:
                    start = max(0, size - int(m.group(2))); end = size - 1
                end = min(end, size - 1)
                if start > end:
                    self.send_response(416); self.send_header("Content-Range", f"bytes */{size}"); self.end_headers(); return
                f.seek(start)
                data = f.read(end - start + 1)
                self.send_response(206)
                self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
            else:
                data = f.read()
                self.send_response(200)
        self.send_header("Content-Type", MIME.get(ext, "application/octet-stream"))
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def static(self, base, rel, extra=None):
        rel = unquote(rel).lstrip("/") or "index.html"
        full = os.path.realpath(os.path.join(base, rel))
        if not full.startswith(os.path.realpath(base) + os.sep):
            return self.send(403, {"error": "forbidden"})
        if os.path.isdir(full):
            full = os.path.join(full, "index.html")
        if not os.path.isfile(full):
            return self.send(404, b"Not found", "text/plain")
        self.send_file(full, extra)

    # -- routes
    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        if not self.host_ok():
            return self.send(403, b"Forbidden", "text/plain")
        path = urlparse(self.path).path
        if path in ("/", "/index.html"):
            with open(os.path.join(UI, "index.html"), encoding="utf-8") as f:
                html = f.read().replace("{{TOKEN}}", TOKEN)
            return self.send(200, html.encode("utf-8"), "text/html; charset=utf-8",
                             {"Content-Security-Policy": ADMIN_CSP, "X-Frame-Options": "DENY"})
        if path.startswith("/ui/"):
            return self.static(UI, path[4:])
        if path == "/site":
            self.send_response(302); self.send_header("Location", "/site/"); self.end_headers(); return
        if path.startswith("/site/"):
            return self.static(SITE, path[6:])
        if path == "/api/state":
            return self.send(200, state())
        if path == "/api/git":
            return self.send(200, git_info())
        if path == "/api/cleanup":
            return self.send(200, {"files": unused_media()})
        self.send(404, b"Not found", "text/plain")

    def do_POST(self):
        if not self.host_ok() or not self.write_ok():
            return self.send(403, {"error": "Forbidden — reload the admin page."})
        path = urlparse(self.path).path
        length = int(self.headers.get("Content-Length") or 0)
        try:
            if path == "/api/upload":
                return self.handle_upload(length)
            if length > 5 * 1048576:
                raise UserError("Request too large.")
            body = json.loads(self.rfile.read(length) or b"{}")
            fn = ROUTES.get(path)
            if not fn:
                return self.send(404, {"error": "Unknown action"})
            with LOCK:
                result = fn(body) or {}
            self.send(200, dict(result, ok=True))
        except UserError as e:
            self.send(400, {"error": str(e)})
        except Exception as e:  # unexpected — show it, keep running
            self.send(500, {"error": f"Unexpected error: {type(e).__name__}: {e}"})

    def handle_upload(self, length):
        if length <= 0:
            raise UserError("Empty upload.")
        if length > MAX_UPLOAD:
            raise UserError("File too large (over 400 MB). Upload videos to YouTube instead.")
        filename = os.path.basename(unquote(self.headers.get("X-Filename", "file")))
        target = self.headers.get("X-Target", "")
        kind = self.headers.get("X-Kind") or None
        if target == "profile":
            folder_rel = "media/profile"
        elif target == "publications":
            folder_rel = "media/publications"
        else:
            pid = slugify(target)
            if not pid:
                raise UserError("Give the project a title before adding media.")
            folder_rel = f"media/projects/{pid}"
        os.makedirs(TMP, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=TMP)
        try:
            with os.fdopen(fd, "wb") as f:
                left = length
                while left:
                    chunk = self.rfile.read(min(1048576, left))
                    if not chunk:
                        break
                    f.write(chunk)
                    left -= len(chunk)
            with LOCK:
                try:
                    res = process_upload(tmp, folder_rel, filename, kind)
                except Exception:
                    folder = os.path.join(SITE, folder_rel)
                    if os.path.isdir(folder) and not os.listdir(folder) and folder_rel.startswith("media/projects/"):
                        os.rmdir(folder)  # don't leave empty folders behind
                    raise
                if kind == "photo":
                    set_site_key("photo", res["src"])
                elif kind == "cv":
                    set_site_key("cv", res["src"])
            self.send(200, dict(res, ok=True))
        finally:
            try:
                os.remove(tmp)
            except OSError:
                pass


def main():
    if not os.path.isdir(CONTENT):
        sys.exit(f"Can't find {CONTENT}. Run this from the portfolio folder.")
    port = PORT
    for _ in range(20):
        try:
            httpd = ThreadingHTTPServer((HOST, port), Handler)
            break
        except OSError:
            port += 1
    else:
        sys.exit("No free port found.")
    url = f"http://127.0.0.1:{port}/"
    print("\n  Portfolio admin is running:  " + url)
    print("  Only this computer can open it. Press Ctrl+C here to stop.\n")
    if not FFMPEG:
        print("  (Optional) Install ffmpeg to auto-compress videos.\n")
    if not os.environ.get("PORTFOLIO_ADMIN_NO_BROWSER"):
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
