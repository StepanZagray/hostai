"""Optional custom UI served under ``/ui/``.

A :class:`CustomUI` points at a directory of static files.  The constructor
checks the *entry* HTML document (default ``index.html``) and every asset it
directly references through ``<script src>``, ``<link href>`` and
``<img src>``; :meth:`CustomUI.asset` serves any supported file inside the
directory with the same safety rules at request time.

What the constructor enforces (this is a wiring check, not a security audit):

* the entry exists inside the directory, is ``.html`` and at most 8 MiB;
* it loads ``hostai-bridge.js`` through an external ``<script src>``.  HostAI
  supplies that file at runtime, so it need not exist on disk;
* no inline ``<script>`` elements, no ``on*`` event handler attributes, no
  ``javascript:`` URLs and no ``<base>`` element (the host's sandbox CSP would
  block the former and ``<base>`` would defeat the reference checks);
* referenced HTML assets are relative, carry no query or
  fragment, do not leave the directory (also via symlinks), exist, use a
  supported extension and fit the size limit.

Only the entry and its direct references are inspected; the SDK never walks
the directory tree or any other location.
"""

from __future__ import annotations

import posixpath
import re
from html.parser import HTMLParser
from pathlib import Path
from typing import Any, NamedTuple
from urllib.parse import unquote

from .errors import AssetError, ContractError

__all__ = ["Asset", "CustomUI", "BRIDGE_SCRIPT", "MAX_ASSET_BYTES", "CONTENT_TYPES"]

BRIDGE_SCRIPT = "hostai-bridge.js"
MAX_ASSET_BYTES = 8 * 1024 * 1024
CONTENT_TYPES: dict[str, str] = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".json": "application/json",
    ".mjs": "text/javascript; charset=utf-8",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".wasm": "application/wasm",
    ".txt": "text/plain; charset=utf-8",
    ".map": "application/json",
}
_MOUNT = "/ui/"
_SCHEME_RE = re.compile(r"^[A-Za-z][A-Za-z0-9+.\-]*:")
_MAX_PATH_CHARS = 1024


class Asset(NamedTuple):
    """A served UI file: raw bytes and the ``Content-Type`` header value."""

    body: bytes
    content_type: str


# --------------------------------------------------------------------------- #
# path handling
# --------------------------------------------------------------------------- #


def normalize_relative(path: str, *, what: str = "path") -> str:
    """Validate ``path`` as a safe, normalized, slash-separated relative path.

    Accepts ``index.html``, ``css/app.css`` or ``/ui/css/app.css``.  Rejects
    absolute paths, ``.``/``..`` segments, empty segments, hidden segments,
    backslashes, control characters, queries and fragments.  Raises
    ``ValueError`` so callers can map it to the right error type.
    """
    if not isinstance(path, str):
        raise ValueError(f"{what} must be a string")
    if not path or len(path) > _MAX_PATH_CHARS:
        raise ValueError(
            f"{what} must be a non-empty string of at most {_MAX_PATH_CHARS} characters"
        )
    if path.startswith(_MOUNT):
        path = path[len(_MOUNT) :]
    if path.startswith("/"):
        raise ValueError(f"{what} must be relative to the UI directory (or start with {_MOUNT})")
    if "?" in path or "#" in path:
        raise ValueError(f"{what} must not contain a query string or fragment")
    if "\\" in path or "\x00" in path or any(ord(ch) < 0x20 or ch == "\x7f" for ch in path):
        raise ValueError(f"{what} contains forbidden characters")
    segments = path.split("/")
    if len(segments) > 7 or len(path) + len(_MOUNT) > _MAX_PATH_CHARS:
        raise ValueError(f"{what} exceeds the gateway path limit")
    for segment in segments:
        if re.fullmatch(r"[A-Za-z0-9._-]+", segment) is None:
            raise ValueError(f"{what} contains unsupported path characters")
        if segment in ("", ".", ".."):
            raise ValueError(f"{what} must not contain empty, '.' or '..' segments")
        if segment.startswith("."):
            raise ValueError(f"{what} must not reference hidden files")
    return "/".join(segments)


def _resolve_inside(root: Path, relative: str) -> Path:
    """Resolve ``relative`` (already normalized) under ``root``; never escape."""
    candidate = root.joinpath(*relative.split("/"))
    try:
        real = candidate.resolve(strict=True)
    except (FileNotFoundError, NotADirectoryError):
        raise LookupError(f"'{relative}' does not exist in the UI directory") from None
    except (OSError, RuntimeError) as exc:  # permission problems, symlink loops
        raise LookupError(f"'{relative}' cannot be resolved: {exc.__class__.__name__}") from None
    if real == root or not real.is_relative_to(root):
        raise LookupError(f"'{relative}' resolves outside the UI directory")
    if not real.is_file():
        raise LookupError(f"'{relative}' is not a regular file")
    return real


def _read_asset(root: Path, relative: str) -> Asset:
    """Load one supported file that lives inside ``root`` (raises LookupError)."""
    suffix = posixpath.splitext(relative)[1].lower()
    content_type = CONTENT_TYPES.get(suffix)
    if content_type is None:
        raise LookupError(
            f"'{relative}' has an unsupported extension; allowed: "
            + ", ".join(sorted(CONTENT_TYPES))
        )
    real = _resolve_inside(root, relative)
    try:
        if real.stat().st_size > MAX_ASSET_BYTES:
            raise LookupError(f"'{relative}' exceeds {MAX_ASSET_BYTES} bytes")
        with real.open("rb") as handle:
            body = handle.read(MAX_ASSET_BYTES + 1)
    except OSError as exc:
        raise LookupError(f"'{relative}' cannot be read: {exc.__class__.__name__}") from None
    if len(body) > MAX_ASSET_BYTES:
        raise LookupError(f"'{relative}' exceeds {MAX_ASSET_BYTES} bytes")
    return Asset(body, content_type)


# --------------------------------------------------------------------------- #
# HTML inspection
# --------------------------------------------------------------------------- #


class _Reference(NamedTuple):
    tag: str
    attribute: str
    value: str


class _EntryScanner(HTMLParser):
    """Collect asset references and flag constructs the sandbox CSP would block."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.references: list[_Reference] = []
        self.problems: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attributes = {name.lower(): (value or "") for name, value in attrs}
        for name, value in attributes.items():
            if name.startswith("on"):
                self.problems.append(f"<{tag}> uses inline event handler attribute '{name}'")
            if value.strip().lower().startswith("javascript:"):
                self.problems.append(f"<{tag} {name}> uses a 'javascript:' URL")
        if tag == "base":
            self.problems.append("<base> is not allowed because it changes how asset paths resolve")
        elif tag == "script":
            if "src" not in attributes:
                self.problems.append(
                    "inline <script> elements are not allowed; load code via <script src>"
                )
            else:
                self.references.append(_Reference("script", "src", attributes["src"]))
        elif tag == "link" and "href" in attributes:
            self.references.append(_Reference("link", "href", attributes["href"]))
        elif tag == "img" and "src" in attributes:
            self.references.append(_Reference("img", "src", attributes["src"]))

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.handle_starttag(tag, attrs)


def _reference_target(entry_dir: str, raw: str) -> str:
    """Turn an HTML reference into a normalized path relative to the UI root."""
    value = raw.strip()
    if not value:
        raise ValueError("is empty")
    if "?" in value or "#" in value:
        raise ValueError("must not contain a query string or fragment")
    if value.startswith("/") or "%" in value or _SCHEME_RE.match(value):
        raise ValueError(
            "must be a relative path inside the UI directory, not an external reference"
        )
    value = unquote(value)
    if value.startswith(_MOUNT):
        joined = value[len(_MOUNT) :]
    elif value.startswith("/"):
        raise ValueError(f"must be relative or start with {_MOUNT}")
    else:
        joined = posixpath.join(entry_dir, value)
    normalized = posixpath.normpath(joined)
    if normalized in (".", "") or normalized.startswith("../") or normalized == "..":
        raise ValueError("escapes the UI directory")
    if entry_dir and not normalized.startswith(entry_dir + "/"):
        raise ValueError("escapes the entry directory proxied by HostAI")
    return normalize_relative(normalized)


# --------------------------------------------------------------------------- #
# public class
# --------------------------------------------------------------------------- #


class CustomUI:
    """Static files for a provider's custom UI, served under ``/ui/``."""

    __slots__ = ("_root", "_entry")

    def __init__(self, directory: str | Path, entry: str = "index.html") -> None:
        try:
            root = Path(directory).resolve(strict=True)
        except (OSError, RuntimeError) as exc:
            raise ContractError(
                f"UI directory {str(directory)!r} cannot be resolved: {exc.__class__.__name__}"
            ) from None
        if not root.is_dir():
            raise ContractError(f"UI directory {str(directory)!r} is not a directory")
        try:
            entry_rel = normalize_relative(entry, what="entry")
        except ValueError as exc:
            raise ContractError(f"UI entry {entry!r}: {exc}") from None
        if not entry_rel.lower().endswith(".html"):
            raise ContractError(f"UI entry {entry!r} must be an .html file")
        self._root = root
        self._entry = entry_rel
        self._check_entry()

    def _check_entry(self) -> None:
        try:
            asset = _read_asset(self._root, self._entry)
        except LookupError as exc:
            raise ContractError(f"UI entry: {exc}") from None
        try:
            text = asset.body.decode("utf-8")
        except UnicodeDecodeError:
            raise ContractError("UI entry must be UTF-8 encoded HTML") from None
        scanner = _EntryScanner()
        scanner.feed(text)
        scanner.close()
        if scanner.problems:
            raise ContractError("UI entry is not sandbox-safe: " + "; ".join(scanner.problems))

        entry_dir = posixpath.dirname(self._entry)
        bridge_loaded = False
        for ref in scanner.references:
            try:
                target = _reference_target(entry_dir, ref.value)
            except ValueError as exc:
                raise ContractError(
                    f"UI entry <{ref.tag} {ref.attribute}={ref.value!r}> {exc}"
                ) from None
            if ref.tag == "script" and posixpath.basename(target) == BRIDGE_SCRIPT:
                bridge_loaded = True
                continue  # supplied by HostAI at runtime
            try:
                _read_asset(self._root, target)
            except LookupError as exc:
                raise ContractError(
                    f"UI entry <{ref.tag} {ref.attribute}={ref.value!r}>: {exc}"
                ) from None
        if not bridge_loaded:
            raise ContractError(
                f'UI entry must load the HostAI bridge with <script src="{BRIDGE_SCRIPT}"></script>'
            )

    # -- read-only views ------------------------------------------------------

    @property
    def directory(self) -> Path:
        """The resolved UI root directory."""
        return self._root

    @property
    def entry(self) -> str:
        """Entry document path relative to the UI directory (e.g. ``index.html``)."""
        return self._entry

    @property
    def entry_url(self) -> str:
        """Public path of the entry document, e.g. ``/ui/index.html``."""
        return _MOUNT + self._entry

    def to_manifest(self) -> dict[str, Any]:
        return {"entry": self.entry_url}

    # -- serving --------------------------------------------------------------

    def asset(self, path: str) -> Asset:
        """Return the bytes and content type of a supported file under ``/ui/``.

        ``path`` may be ``index.html`` or ``/ui/index.html``.  It is treated as
        a literal relative path (no percent-decoding).  Raises
        :class:`AssetError` for anything missing, unsafe or unsupported.
        """
        try:
            relative = normalize_relative(path, what="asset path")
            return _read_asset(self._root, relative)
        except (ValueError, LookupError) as exc:
            raise AssetError(str(exc)) from None

    def __repr__(self) -> str:
        return f"CustomUI(directory={str(self._root)!r}, entry={self._entry!r})"
