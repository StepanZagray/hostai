"""Standard-library HTTP handler for a :class:`~hostai.Provider`.

Routes (exact paths, nothing else):

* ``GET  /hostai/manifest``  -> ``application/json`` manifest
* ``GET  /ui/<asset>``       -> static UI file (404 when the provider has no UI)
* ``POST /hostai/infer``     -> ``{"model": name, "input": json}`` -> raw JSON result

The caller owns the server (bind it to loopback) and starts it explicitly;
importing this module or calling ``provider.handler()`` never listens.
Request bodies must carry ``Content-Length`` (at most 262144 bytes);
``Transfer-Encoding`` is rejected.  Failures inside the provider produce a
generic ``500`` body so exceptions never leak to clients.
"""

from __future__ import annotations

import json
import logging
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler
from typing import TYPE_CHECKING, Any
from urllib.parse import unquote

from ._json import dumps
from .errors import AssetError, ContractError, InputError, UnknownModelError

if TYPE_CHECKING:  # pragma: no cover
    from .provider import Provider

__all__ = ["make_handler", "MAX_BODY_BYTES", "MANIFEST_PATH", "INFER_PATH", "UI_PREFIX"]

MAX_BODY_BYTES = 262_144
MANIFEST_PATH = "/hostai/manifest"
INFER_PATH = "/hostai/infer"
UI_PREFIX = "/ui/"
_MAX_REQUEST_PATH = 2048
_MAX_ERROR_MESSAGE = 256
_JSON = "application/json"

log = logging.getLogger("hostai.http")


class _Reply(Exception):
    """Internal: unwind a request with a JSON error response."""

    def __init__(self, status: HTTPStatus, code: str, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message[:_MAX_ERROR_MESSAGE]


def make_handler(
    provider: Provider, *, infer_aliases: dict[str, str] | None = None
) -> type[BaseHTTPRequestHandler]:
    """Create a request handler class bound to ``provider``."""

    aliases = dict(infer_aliases or {})
    for path, model in aliases.items():
        if (
            not isinstance(path, str)
            or not path.startswith("/")
            or path.startswith(("/hostai", "/ui"))
            or any(char in path for char in "?#%\\")
            or "//" in path
            or any(part in (".", "..") for part in path.split("/"))
        ):
            raise ContractError(
                "inference aliases must be simple absolute paths outside /hostai and /ui"
            )
        provider.model(model)

    class HostAIRequestHandler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        server_version = "hostai-provider/1"
        sys_version = ""
        hostai_provider = provider

        def setup(self) -> None:
            super().setup()
            self.connection.settimeout(10)

        # -- routing ----------------------------------------------------------

        def do_GET(self) -> None:  # noqa: N802 (stdlib naming)
            self._run(self._get)

        def do_POST(self) -> None:  # noqa: N802
            self._run(self._post)

        def do_HEAD(self) -> None:  # noqa: N802
            self._run(self._method_not_allowed)

        do_PUT = do_DELETE = do_PATCH = do_OPTIONS = do_HEAD

        def _run(self, route: Any) -> None:
            self.close_connection = True
            try:
                if len(self.path) > _MAX_REQUEST_PATH:
                    raise _Reply(HTTPStatus(414), "uri_too_long", "request path is too long")
                route()
            except _Reply as reply:
                self._send_error(reply.status, reply.code, reply.message)
            except Exception:  # noqa: BLE001 - never leak, never crash the thread
                log.error("provider HTTP handler failed")
                self._send_error(
                    HTTPStatus.INTERNAL_SERVER_ERROR, "internal_error", "internal error"
                )

        def _get(self) -> None:
            path = self._path_only()
            if path == MANIFEST_PATH:
                self._send(HTTPStatus.OK, self.hostai_provider.manifest_bytes(), _JSON)
                return
            if path.startswith(UI_PREFIX):
                self._serve_asset(path)
                return
            if path == INFER_PATH:
                self._method_not_allowed()
                return
            raise _Reply(HTTPStatus.NOT_FOUND, "not_found", "no such route")

        def _post(self) -> None:
            path = self._path_only()
            if path == INFER_PATH:
                self._infer()
                return
            if path in aliases:
                self._infer(aliases[path])
                return
            if path == MANIFEST_PATH or path.startswith(UI_PREFIX):
                self._method_not_allowed()
                return
            raise _Reply(HTTPStatus.NOT_FOUND, "not_found", "no such route")

        def _method_not_allowed(self) -> None:
            raise _Reply(HTTPStatus.METHOD_NOT_ALLOWED, "method_not_allowed", "method not allowed")

        # -- routes -----------------------------------------------------------

        def _serve_asset(self, path: str) -> None:
            if self.hostai_provider.ui is None:
                raise _Reply(HTTPStatus.NOT_FOUND, "not_found", "this provider has no custom UI")
            relative = unquote(path[len(UI_PREFIX) :])
            try:
                asset = self.hostai_provider.asset(relative)
            except AssetError:
                raise _Reply(HTTPStatus.NOT_FOUND, "not_found", "no such asset") from None
            # HostAI owns embedding CSP; direct provider pages may use standalone fetch.
            self._send(HTTPStatus.OK, asset.body, asset.content_type)

        def _infer(self, alias_model: str | None = None) -> None:
            envelope = self._read_json_body()
            if alias_model is not None:
                envelope = {"model": alias_model, "input": envelope}
            if not isinstance(envelope, dict) or set(envelope) != {"model", "input"}:
                raise _Reply(
                    HTTPStatus.BAD_REQUEST,
                    "invalid_envelope",
                    'request body must be a JSON object with exactly the keys "model" and "input"',
                )
            if not isinstance(envelope["model"], str):
                raise _Reply(HTTPStatus.BAD_REQUEST, "invalid_envelope", '"model" must be a string')
            try:
                output = self.hostai_provider.infer(envelope["model"], envelope["input"])
            except UnknownModelError:
                raise _Reply(HTTPStatus.BAD_REQUEST, "unknown_model", "unknown model") from None
            except InputError as exc:
                raise _Reply(HTTPStatus.BAD_REQUEST, "invalid_input", str(exc)) from None
            except Exception:  # InferenceError, OutputError, anything else -> generic 500
                log.error("provider inference failed")
                raise _Reply(
                    HTTPStatus.INTERNAL_SERVER_ERROR, "inference_failed", "inference failed"
                ) from None
            body = dumps(output)
            if len(body) > MAX_BODY_BYTES:
                raise _Reply(
                    HTTPStatus.INTERNAL_SERVER_ERROR,
                    "output_too_large",
                    "provider output exceeds 262144 bytes",
                )
            self._send(HTTPStatus.OK, body, _JSON)

        # -- request plumbing -------------------------------------------------

        def _path_only(self) -> str:
            path = self.path
            if "?" in path or "#" in path:
                raise _Reply(
                    HTTPStatus.NOT_FOUND,
                    "not_found",
                    "query strings and fragments are not supported",
                )
            return path

        def _read_json_body(self) -> Any:
            if self.headers.get("Transfer-Encoding") is not None:
                raise _Reply(
                    HTTPStatus.BAD_REQUEST,
                    "transfer_encoding",
                    "Transfer-Encoding is not supported",
                )
            raw_length = self.headers.get("Content-Length")
            if len(self.headers.get_all("Content-Length", [])) > 1:
                raise _Reply(
                    HTTPStatus.BAD_REQUEST, "bad_length", "Content-Length must be specified once"
                )
            if raw_length is None:
                raise _Reply(
                    HTTPStatus.LENGTH_REQUIRED, "length_required", "Content-Length is required"
                )
            try:
                if not raw_length.isascii() or not raw_length.isdecimal():
                    raise ValueError("invalid length")
                length = int(raw_length)
            except ValueError:
                raise _Reply(
                    HTTPStatus.BAD_REQUEST, "bad_length", "Content-Length is not an integer"
                ) from None
            if length < 0:
                raise _Reply(HTTPStatus.BAD_REQUEST, "bad_length", "Content-Length is negative")
            if length > MAX_BODY_BYTES:
                raise _Reply(
                    HTTPStatus(413),
                    "body_too_large",
                    f"request body exceeds {MAX_BODY_BYTES} bytes",
                )
            content_type = self.headers.get("Content-Type", _JSON).split(";", 1)[0].strip().lower()
            if content_type != _JSON:
                raise _Reply(
                    HTTPStatus.UNSUPPORTED_MEDIA_TYPE,
                    "unsupported_media_type",
                    "expected application/json",
                )
            body = self.rfile.read(length)
            if len(body) != length:
                raise _Reply(
                    HTTPStatus.BAD_REQUEST,
                    "short_body",
                    "request body was shorter than Content-Length",
                )
            try:
                return json.loads(body.decode("utf-8"))
            except (UnicodeDecodeError, ValueError, RecursionError):
                raise _Reply(
                    HTTPStatus.BAD_REQUEST, "invalid_json", "request body is not valid JSON"
                ) from None

        # -- responses --------------------------------------------------------

        def _send(
            self,
            status: HTTPStatus,
            body: bytes,
            content_type: str,
            extra: dict[str, str] | None = None,
        ) -> None:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Connection", "close")
            for name, value in (extra or {}).items():
                self.send_header(name, value)
            self.end_headers()
            self.wfile.write(body)

        def _send_error(self, status: HTTPStatus, code: str, message: str) -> None:
            try:
                body = dumps({"error": message})
                self._send(status, body, _JSON)
            except OSError:  # client went away; nothing more to do
                pass

        def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
            log.debug("%s - %s", self.address_string(), format % args)

    return HostAIRequestHandler
