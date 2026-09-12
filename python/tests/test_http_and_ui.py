"""Real loopback HTTP and custom-UI validation; never starts a browser or model."""

import json
import socket
import tempfile
import threading
import unittest
from contextlib import contextmanager
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
from pathlib import Path

from hostai import AssetError, ContractError, CustomUI, InputError, Model, Provider
from test_provider import make_interaction


@contextmanager
def running(provider, **kwargs):
    with ThreadingHTTPServer(("127.0.0.1", 0), provider.handler(**kwargs)) as server:
        thread = threading.Thread(target=server.serve_forever)
        thread.start()
        try:
            yield server.server_port
        finally:
            server.shutdown()
            thread.join(timeout=5)
            assert not thread.is_alive()


def request(port, path, value=None, *, method=None, headers=None):
    body = json.dumps(value).encode() if value is not None else None
    connection = HTTPConnection("127.0.0.1", port, timeout=5)
    try:
        connection.request(
            method or ("POST" if body else "GET"),
            path,
            body,
            headers or {"Content-Type": "application/json"},
        )
        response = connection.getresponse()
        return response.status, response.read(), dict(response.getheaders())
    finally:
        connection.close()


class HttpTests(unittest.TestCase):
    def test_headless_routes_and_alias_return_raw_values(self):
        calls = []

        def echo(value):
            calls.append(value)
            return value

        provider = Provider("echo", [Model("echo", echo, make_interaction())])
        with running(provider, infer_aliases={"/predict": "echo"}) as port:
            code, raw, _ = request(port, "/hostai/manifest")
            self.assertEqual(code, 200)
            self.assertEqual(json.loads(raw), provider.manifest())
            self.assertEqual(calls, [])
            for path, body in [
                ("/hostai/infer", {"model": "echo", "input": {"text": "first"}}),
                ("/predict", {"text": "second"}),
            ]:
                code, raw, headers = request(port, path, body)
                self.assertEqual(code, 200)
                self.assertEqual(set(json.loads(raw)), {"text"})
                self.assertEqual(headers["Cache-Control"], "no-store")
            self.assertEqual(calls, [{"text": "first"}, {"text": "second"}])
            self.assertEqual(request(port, "/ui/index.html")[0], 404)

    def test_errors_are_wire_compatible_and_provider_failures_do_not_leak(self):
        def infer(value):
            if value["text"] == "domain":
                raise InputError("Invalid level geometry")
            if value["text"] == "boom":
                raise RuntimeError("private-secret")
            return {"wrong": "private-secret"}

        provider = Provider("echo", [Model("echo", infer, make_interaction())])
        with running(provider) as port:
            for value, status in [
                ({"model": "missing", "input": {}}, 400),
                ({"model": "echo", "input": {}}, 400),
                ({"model": "echo", "input": {"text": "domain"}}, 400),
                ({"model": "echo", "input": {"text": "boom"}}, 500),
                ({"model": "echo", "input": {"text": "output"}}, 500),
                ({"model": "echo"}, 400),
            ]:
                with self.subTest(value=value):
                    code, raw, _ = request(port, "/hostai/infer", value)
                    self.assertEqual(code, status)
                    self.assertIsInstance(json.loads(raw)["error"], str)
                    self.assertNotIn(b"private-secret", raw)

    def test_body_bounds_content_type_and_duplicate_lengths(self):
        provider = Provider("echo", [Model("echo", lambda value: value, make_interaction())])
        with running(provider) as port:
            self.assertEqual(
                request(port, "/hostai/infer", {}, headers={"Content-Type": "text/plain"})[0], 415
            )
            self.assertEqual(request(port, "/hostai/infer", {"text": "x" * 262144})[0], 413)
            self.assertEqual(
                request(port, "/hostai/infer", {}, headers={"Transfer-Encoding": "chunked"})[0], 400
            )
            self.assertEqual(request(port, "/hostai/infer", method="GET")[0], 405)
            with socket.create_connection(("127.0.0.1", port), timeout=5) as client:
                client.sendall(
                    b"POST /hostai/infer HTTP/1.1\r\nHost: localhost\r\nContent-Length: 2\r\nContent-Length: 1\r\n\r\n{}"
                )
                self.assertIn(b"400", client.recv(4096).split(b"\r\n")[0])

    def test_output_size_is_bounded(self):
        provider = Provider(
            "echo", [Model("echo", lambda value: {"text": "x" * 262144}, make_interaction())]
        )
        with running(provider) as port:
            self.assertEqual(
                request(port, "/hostai/infer", {"model": "echo", "input": {"text": "go"}})[0], 500
            )

    def test_aliases_cannot_override_protocol_routes(self):
        provider = Provider("echo", [Model("echo", lambda value: value, make_interaction())])
        for path in [
            "relative",
            "/hostai/infer",
            "/ui/index.html",
            "/x?y",
            "/../escape",
            "/bad%20path",
        ]:
            with self.subTest(path=path), self.assertRaises(ContractError):
                provider.handler(infer_aliases={path: "echo"})


class UiTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="hostai-sdk-ui-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "ui"
        self.root.mkdir()
        self.html = (
            '<!doctype html><script src="hostai-bridge.js"></script><script src="app.js"></script>'
        )
        (self.root / "index.html").write_text(self.html)
        (self.root / "app.js").write_text("window.example = true;")

    def test_real_ui_assets_and_inference_share_a_provider(self):
        ui = CustomUI(self.root)
        self.assertEqual(ui.entry_url, "/ui/index.html")
        provider = Provider("echo", [Model("echo", lambda value: value, make_interaction())], ui)
        with running(provider) as port:
            code, raw, headers = request(port, "/ui/index.html")
            self.assertEqual(code, 200)
            self.assertEqual(raw.decode(), self.html)
            self.assertEqual(headers["Content-Type"], "text/html; charset=utf-8")
            self.assertEqual(
                request(port, "/hostai/infer", {"model": "echo", "input": {"text": "no browser"}})[
                    0
                ],
                200,
            )

    def test_startup_checks_bridge_assets_and_csp_incompatible_html(self):
        for html in [
            "<html></html>",
            "<script>alert(1)</script>",
            self.html + '<button onclick="go()">Go</button>',
            self.html + '<script src="https://example.com/app.js"></script>',
            self.html.replace('src="app.js"', 'src="/ui/app.js"'),
            self.html.replace('src="app.js"', 'src="missing.js"'),
            self.html.replace('src="app.js"', 'src="app.js?v=1"'),
        ]:
            with self.subTest(html=html):
                (self.root / "index.html").write_text(html)
                with self.assertRaises(ContractError):
                    CustomUI(self.root)

    def test_paths_symlinks_and_nested_entry_root_match_gateway(self):
        secret = Path(self.temp.name) / "secret.json"
        secret.write_text("{}")
        (self.root / "escape.json").symlink_to(secret)
        ui = CustomUI(self.root)
        for path in [
            "../secret.json",
            "escape.json",
            "bad%20name.js",
            "foo bar.js",
            "a/" * 8 + "app.js",
            "/outside.js",
        ]:
            with self.subTest(path=path), self.assertRaises(AssetError):
                ui.asset(path)
        nested = self.root / "nested"
        nested.mkdir()
        (nested / "index.html").write_text(self.html)
        (nested / "app.js").write_text("window.example=true;")
        self.assertEqual(
            CustomUI(self.root, "nested/index.html").entry_url, "/ui/nested/index.html"
        )
        (nested / "index.html").write_text(self.html.replace('src="app.js"', 'src="../app.js"'))
        with self.assertRaises(ContractError):
            CustomUI(self.root, "nested/index.html")


if __name__ == "__main__":
    unittest.main()
