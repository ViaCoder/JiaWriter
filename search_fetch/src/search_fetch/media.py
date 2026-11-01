"""search_fetch.media — video/audio understanding for the knowledge base.

ONE ladder per media URL, ordered by cost:
  1. metadata (title/uploader/date/description) — always, via yt-dlp probe
  2. subtitles — manual first, then auto captions (any language, original
     preferred) — fetched inline, no media download
  3. ASR — ONLY for short, downloadable media with no subtitles: the audio is
     downloaded (size-capped) and transcribed on the Qwen3-ASR HuggingFace
     Space with automatic language detection. On the CLI path this runs as a
     detached background task (search_fetch.tasks) so it never blocks further
     searching/fetching; `sf.py fetch --sync` runs it inline, deadline-bounded.

Live streams and media past SEARCH_FETCH_ASR_MAX_DURATION / _MAX_MB are NEVER
downloaded — video has low information density, so metadata + description +
the note of what was skipped is the honest, cheap representation.

yt-dlp is the single retrieval dependency: it covers YouTube, most video
sites AND direct audio/video file URLs (generic extractor).
"""

# The yt-dlp session context manager.
import contextlib

# Subtitle cleaning.
import re

# ffmpeg lookup and temp-dir removal.
import shutil

# Temp download directory.
import tempfile

# Backoff between ASR attempts.
import time

# URL parsing.
import urllib.parse

# Subtitle track requests.
import urllib.request

# Path arithmetic.
from pathlib import Path

# Knobs, clamps, pacing, the task spool and the outbound policy.
from . import config, markdown, pacing, tasks, url_guard

# Shared stderr logger.
from .config import _log

# Deadline-bounded calls.
from .docparse import _call_deadline

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


def _asr_eligibility(info: dict) -> str:
    """'' when ASR may run; otherwise the human-readable reason it must not."""
    # Switched off.
    if not config.ASR_ENABLED:
        return "ASR 已禁用（SEARCH_FETCH_ASR=off）"
    # Live streams are never downloaded.
    if info.get("is_live"):
        return "直播流不下载，仅收录元数据与简介"
    # Too long.
    dur = info.get("duration")
    if isinstance(dur, (int, float)) and dur > config.ASR_MAX_DURATION:
        return (f"时长 {int(dur)}s 超过 ASR 上限 {int(config.ASR_MAX_DURATION)}s，"
                f"不下载，仅收录元数据与简介")
    # Too large.
    size = info.get("filesize") or info.get("filesize_approx")
    if isinstance(size, (int, float)) and size > config.ASR_MAX_MB * 1024 * 1024:
        return f"文件约 {int(size) // (1024 * 1024)}MB 超过 {config.ASR_MAX_MB}MB 上限，不下载"
    # Eligible.
    return ""


def fetch_media(url: str, kind: str, defer: bool) -> dict:
    """The media fetch: returns {final_url, markdown[, task]}. Never raises for a
    normal media page — a probe failure is reported in the markdown so the
    research loop can move on (the Rust runner treats empty stdout as failure)."""
    # Metadata first.
    try:
        info = probe(url)
    except Exception as ex:
        # A plain file server can refuse metadata probes; the worker's size cap still protects the download.
        if kind == "media":
            info = {"title": url.rsplit("/", 1)[-1], "webpage_url": url}
            _log(f"media probe failed ({str(ex)[:80]}); proceeding on caps only")
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
    # Why ASR may not run, if it may not.
    reason = _asr_eligibility(info)
    if reason:
        parts += ["", f"（无可用字幕；{reason}）"]
        return {"final_url": final, "markdown": "\n".join(parts)}
    # What the ASR worker needs.
    payload = {"url": url, "source": final, "title": info.get("title") or "", "duration": info.get("duration")}
    # Background task on the CLI path.
    if defer:
        tid = tasks.enqueue("asr", payload)
        parts += ["", f"[语音转写已在后台运行：task {tid}；文本将在 `tasks wait` 汇合后并入知识库]"]
        return {"final_url": final, "markdown": "\n".join(parts), "task": tid}
    # Inline (--sync): a failure becomes a note.
    try:
        parts += ["", "## 内容转写（ASR）", markdown._clamp_chars(transcribe(payload), config.FETCH_MAX_CHARS)]
    except Exception as ex:
        parts += ["", f"（无可用字幕；ASR 失败：{str(ex)[:160]}）"]
    # The page.
    return {"final_url": final, "markdown": "\n".join(parts)}


def _download_audio(url: str, tmpdir: str) -> Path:
    """Download the smallest useful AUDIO rendition, size-capped. When the source
    is video-only or a video container and ffmpeg exists, extract audio to m4a
    (the ASR Space wants an audio file); without ffmpeg the downloaded file is
    offered to the Space as-is."""
    # yt-dlp options.
    opts = {
        # Only protocols yt-dlp downloads in-process (http/https/DASH, native HLS): rtmp/rtsp/ffmpeg
        # formats would hand the fetch to an external program that resolves hosts outside the guard.
        "format": "/".join(f"{base}[protocol{proto}]"
                           for base in ("bestaudio[abr<=128]", "bestaudio", "best")
                           for proto in ("^=http", "=m3u8_native")),
        # Fixed name inside the temp directory.
        "outtmpl": str(Path(tmpdir) / "audio.%(ext)s"),
        # Size cap.
        "max_filesize": config.ASR_MAX_MB * 1024 * 1024,
        "match_filter": None,
    }
    # Audio extraction when ffmpeg is available.
    if shutil.which("ffmpeg"):
        opts["postprocessors"] = [{"key": "FFmpegExtractAudio", "preferredcodec": "m4a", "preferredquality": "96"}]
    # Download under the policy guard.
    with _ytdl(opts) as y:
        y.download([url])
    # Largest produced file first.
    files = sorted(Path(tmpdir).glob("audio.*"), key=lambda p: p.stat().st_size, reverse=True)
    # The size cap stops yt-dlp without an error, so an empty result is reported here.
    if not files:
        raise RuntimeError(f"download produced no file (max {config.ASR_MAX_MB}MB — size cap hit?)")
    # The audio file.
    return files[0]


def _asr_file(path: Path) -> str:
    """One audio file → transcription via the Qwen3-ASR Space (auto language).
    Deadline-bounded per remote call; a couple of retries, then the error raises."""
    # Imported lazily: only the ASR worker needs it.
    from gradio_client import Client, handle_file
    # Connecting is bounded too.
    client = _call_deadline(lambda: Client(config.ASR_SPACE, verbose=False), config.ASR_TIMEOUT)
    # Last error, for the final message.
    last = None
    # Bounded attempts.
    for attempt in range(1, config.ASR_RETRIES + 1):
        try:
            # One remote transcription with automatic language detection.
            res = _call_deadline(
                lambda: client.predict(handle_file(str(path)), "Auto", False, api_name=config.ASR_API),
                config.ASR_TIMEOUT)
            # The Space returns (language, text).
            pair = isinstance(res, (list, tuple)) and len(res) > 1
            # Detected language.
            detected = str(res[0]).strip() if pair else ""
            # Transcript.
            text = str(res[1] if pair else res).strip()
            # An empty transcript is a failure.
            if not text:
                raise RuntimeError("ASR returned empty text")
            # Transcript with the detected language noted.
            return f"（检测语言：{detected}）\n{text}" if detected else text
        except Exception as ex:
            # Remember and log.
            last = ex
            _log(f"ASR attempt {attempt}/{config.ASR_RETRIES} failed: {str(ex)[:120]}")
            # Linear backoff before the next attempt.
            if attempt < config.ASR_RETRIES:
                time.sleep(5 * attempt)
    # All attempts failed.
    raise RuntimeError(f"ASR failed after {config.ASR_RETRIES} attempts: {str(last)[:160]}")


def transcribe(payload: dict) -> str:
    """Worker side: download the (short) media's audio and transcribe it.
    Returns the transcript prefixed by the media title."""
    # Media URL.
    url = payload["url"]
    # Scratch space inside the package home (never the system /tmp).
    scratch = config.HOME / "tmp"
    # Create it once.
    scratch.mkdir(parents=True, exist_ok=True)
    # Per-task temp directory.
    tmpdir = tempfile.mkdtemp(prefix="search_fetch_asr_", dir=str(scratch))
    # Download and transcribe; always remove the audio afterwards.
    try:
        audio = _download_audio(url, tmpdir)
        _log(f"ASR: downloaded {audio.name} ({audio.stat().st_size // 1024}KB) — transcribing")
        text = _asr_file(audio)
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)
    # Title and source above the transcript.
    title = payload.get("title") or url
    return f"# {title}（语音转写）\n来源: {payload.get('source') or url}\n\n{text}"
