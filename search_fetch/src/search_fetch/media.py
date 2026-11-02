"""search_fetch.media — video/audio understanding for the knowledge base.

ONE ladder per media URL, ordered by cost:
  1. metadata (title/uploader/date/description) — always, via yt-dlp probe
  2. subtitles — manual first, then auto captions (any language, original
     preferred) — fetched inline, no media download

There is no speech recognition and no media download: media without subtitles
is represented by its metadata and description, with a note that no transcript
is available.

yt-dlp is the single retrieval dependency: it covers YouTube, most video
sites AND direct audio/video file URLs (generic extractor).
"""

# The yt-dlp session context manager.
import contextlib

# Subtitle cleaning.
import re

# URL parsing.
import urllib.parse

# Subtitle track requests.
import urllib.request

# Knobs, clamps, pacing and the outbound policy.
from . import config, markdown, pacing, url_guard

# Shared stderr logger.
from .config import _log

# YouTube host names.
_YT_HOSTS = ("youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be", "music.youtube.com")
# Metadata-only extraction must be quick (seconds).
_PROBE_TIMEOUT = 30.0
# Subtitle track download timeout (seconds).
_SUB_HTTP_TIMEOUT = 30.0
# Largest subtitle track read (bytes).
_SUB_MAX_BYTES = 8 * 1024 * 1024
# A subtitle shorter than this (chars) is treated as unusable.
_SUB_MIN_CHARS = 40
# Description length kept in the metadata block.
_DESC_MAX_CHARS = 2000
# WEBVTT/SRT cue timing lines.
_VTT_TS_RE = re.compile(
    r"^\d{2}:\d{2}(?::\d{2})?[.,]\d{3}\s+-->\s+\d{2}:\d{2}(?::\d{2})?[.,]\d{3}.*$")
# Inline cue tags such as <c> or <00:00:01.000>.
_VTT_TAG_RE = re.compile(r"<[^>]+>")



def _call_deadline(fn, timeout):
    """Run fn() under a hard deadline. yt-dlp's metadata probe carries no overall timeout
    of its own, and a hung site must not stall the whole fetch. The call runs in a daemon
    thread; on deadline it is abandoned (never joined) and TimeoutError raised."""
    import threading
    box = {}
    def _run():
        try:
            box["val"] = fn()
        except BaseException as e:  # surfaced to the caller below
            box["err"] = e
    t = threading.Thread(target=_run, daemon=True)
    t.start()
    t.join(timeout)
    if t.is_alive():
        raise TimeoutError(f"no response within {timeout:.0f}s")
    if "err" in box:
        raise box["err"]
    return box.get("val")

def classify_url(url: str) -> str:
    """'youtube' | 'media' (direct audio/video file) | '' (not media)."""
    # A malformed URL (bad port, bad IPv6 literal) is not media.
    try:
        p = urllib.parse.urlparse(url)
    except ValueError:
        return ""
    # Host without the port.
    host = (p.netloc or "").lower().split(":")[0]
    # YouTube: only real watchable targets; channel/playlist pages read better as web pages.
    if host in _YT_HOSTS:
        if host == "youtu.be" or p.path.startswith(("/watch", "/shorts/", "/live/")):
            return "youtube"
        return ""
    # Last path segment.
    name = (p.path or "").lower().rsplit("/", 1)[-1]
    # Its extension ("" without a dot).
    dot = name.rfind(".")
    ext = name[dot:] if dot != -1 else ""
    # A known audio/video extension means a direct media file.
    return "media" if ext in config.MEDIA_EXTS else ""


@contextlib.contextmanager
def _ytdl(opts: dict):
    """A YoutubeDL that runs under the outbound URL policy: yt-dlp does its own
    HTTP (extractor requests, subtitle/manifest/media fetches) and follows redirects
    inside its handlers, where url_guard's urlopen never sees them — so the whole
    session runs inside url_guard.guard_resolution(), which refuses every name
    resolution that lands on a non-public address (redirect hops included)."""
    # Imported lazily: only media fetches need it.
    import yt_dlp
    # Quiet, bounded, with yt-dlp's cache inside the package home (not ~/.cache/yt-dlp).
    base = {"quiet": True, "no_warnings": True, "noprogress": True,
            "socket_timeout": 20, "retries": 1,
            "cachedir": str(config.HOME / "yt-dlp-cache")}
    # Caller options win.
    base.update(opts)
    # Policy guard around the whole session.
    with url_guard.guard_resolution(), yt_dlp.YoutubeDL(base) as y:
        yield y


def probe(url: str) -> dict:
    """Metadata-only extraction (no download), deadline-bounded. Raises on failure."""
    def _run():
        # Extract without downloading; sanitize to plain JSON types.
        with _ytdl({"skip_download": True}) as y:
            return y.sanitize_info(y.extract_info(url, download=False))
    # Bounded by the probe deadline.
    return _call_deadline(_run, _PROBE_TIMEOUT)


def _meta_block(info: dict, url: str) -> str:
    """Markdown header of a media page: title, source, uploader, date, duration, views, description."""
    # Duration in 分/秒, or 未知.
    dur = info.get("duration")
    dur_s = f"{int(dur // 60)}分{int(dur % 60)}秒" if isinstance(dur, (int, float)) else "未知"
    # Fixed fields.
    lines = [f"# {info.get('title') or url}",
             f"- 来源: {info.get('webpage_url') or url}",
             f"- 上传者: {info.get('uploader') or info.get('channel') or '未知'}",
             f"- 日期: {info.get('upload_date') or '未知'}",
             f"- 时长: {dur_s}" + ("（直播）" if info.get("is_live") else "")]
    # View count when known.
    if info.get("view_count") is not None:
        lines.append(f"- 播放量: {info['view_count']}")
    # Description, bounded.
    desc = (info.get("description") or "").strip()
    if desc:
        lines += ["", "## 简介", markdown._clamp_chars(desc, _DESC_MAX_CHARS)]
    # One block.
    return "\n".join(lines)


def _vtt_to_text(vtt: str) -> str:
    """WEBVTT/SRT → plain text: drop headers/timestamps/tags, dedupe the rolling
    repeats YouTube auto-captions produce."""
    # Kept lines and the previous one.
    out, last = [], ""
    # Each line of the track.
    for line in (vtt or "").splitlines():
        # Trimmed.
        s = line.strip()
        # Headers, cue numbers and timing lines carry no text.
        if not s or s.startswith(("WEBVTT", "Kind:", "Language:", "NOTE", "STYLE")) \
                or s.isdigit() or _VTT_TS_RE.match(s):
            continue
        # Inline tags removed.
        s = _VTT_TAG_RE.sub("", s).strip()
        # Rolling captions repeat the previous line; keep each once.
        if s and s != last:
            out.append(s)
            last = s
    # Plain text.
    return "\n".join(out).strip()


def _sub_lang_order(info: dict, table: dict) -> list:
    """Language preference: the video's ORIGINAL language, then config.SUB_LANG_PREF,
    then whatever else exists (stable order)."""
    # Available track languages.
    langs = list(table or {})
    # Ordered result and the names already handled.
    ordered, seen = [], set()
    # Original language, preferences, then the rest.
    for cand in [info.get("language") or ""] + config.SUB_LANG_PREF + langs:
        # Skip empty and repeated candidates.
        if not cand or cand in seen:
            continue
        # A candidate matches itself and its regional variants (zh → zh-Hans).
        for have in langs:
            if (have == cand or have.startswith(cand + "-")) and have not in seen:
                ordered.append(have)
                seen.add(have)
        # Mark the candidate.
        seen.add(cand)
    # Preference order.
    return ordered


def _fetch_subtitles(info: dict) -> tuple:
    """(lang, text, kind) from manual subtitles first, then auto captions;
    ('', '', '') when none usable. Downloads only the one chosen track."""
    # Manual subtitles before automatic captions.
    for table_key, kind in (("subtitles", "字幕"), ("automatic_captions", "自动字幕")):
        # Tracks by language.
        table = info.get(table_key) or {}
        # In preference order.
        for lang in _sub_lang_order(info, table):
            # First text format with a URL.
            fmt = next((f for f in table.get(lang, []) if f.get("ext") in ("vtt", "srt") and f.get("url")), None)
            # No usable format for this language.
            if not fmt:
                continue
            # Track URLs come out of extractor data: same outbound policy as every other urllib fetch.
            try:
                # Space requests to the subtitle host like every other request.
                pacing.before_request(fmt["url"])
                req = urllib.request.Request(fmt["url"], headers={"User-Agent": "Mozilla/5.0"})
                with url_guard.urlopen(req, timeout=_SUB_HTTP_TIMEOUT) as r:
                    raw = r.read(_SUB_MAX_BYTES).decode("utf-8", "replace")
            except Exception as ex:
                # Try the next language.
                _log(f"subtitle download failed ({lang}): {str(ex)[:100]}")
                continue
            # Plain text of the track.
            text = _vtt_to_text(raw)
            # Long enough to be real content.
            if len(text) >= _SUB_MIN_CHARS:
                return lang, text, kind
    # Nothing usable.
    return "", "", ""


def fetch_media(url: str, kind: str) -> dict:
    """The media fetch: returns {final_url, markdown}. Never raises for a
    normal media page — a probe failure is reported in the markdown so the
    research loop can move on (the Rust runner treats empty stdout as failure)."""
    # Metadata first.
    try:
        info = probe(url)
    except Exception as ex:
        # A plain file server can refuse metadata probes; the file name stands in for the title.
        if kind == "media":
            info = {"title": url.rsplit("/", 1)[-1], "webpage_url": url}
            _log(f"media probe failed ({str(ex)[:80]}); using the file name")
        else:
            # A video page that cannot be read is reported, not raised.
            _log(f"media probe failed: {str(ex)[:120]}")
            return {"final_url": url, "markdown": f"# 媒体页读取失败\n\n- 来源: {url}\n- 原因: {str(ex)[:200]}"}
    # Canonical page URL.
    final = info.get("webpage_url") or url
    # Metadata block.
    parts = [_meta_block(info, url)]
    # Subtitles (YouTube only).
    lang, text, sub_kind = _fetch_subtitles(info) if kind == "youtube" else ("", "", "")
    # Subtitles are the transcript.
    if text:
        parts += ["", f"## 内容转写（{sub_kind}/{lang}）", markdown._clamp_chars(text, config.FETCH_MAX_CHARS)]
        return {"final_url": final, "markdown": "\n".join(parts)}
    # No subtitles: metadata and description only.
    parts += ["", "（无可用字幕，仅收录元数据与简介）"]
    # The page.
    return {"final_url": final, "markdown": "\n".join(parts)}
