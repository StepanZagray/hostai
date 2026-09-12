#!/usr/bin/env python3
"""Smoke-test an installed Python provider, Java gateway and HostAI CLI together.

Uses a synthetic provider by default. --pebby-root uses that checkout's installed
SDK and real environment operations with an explicitly missing checkpoint.
All servers bind ephemeral loopback ports and are stopped before returning.
"""

import argparse
import json
import os
import re
import subprocess
import tempfile
import threading
import time
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.request import Request, urlopen

from hostai import CustomUI, Interaction, Model, Provider

ROOT = Path(__file__).resolve().parents[1]


def json_request(origin, path, body=None):
    request = Request(
        origin + path,
        data=None if body is None else json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urlopen(request, timeout=15) as response:
        return json.load(response)


def wait_log(process, path, pattern):
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        content = path.read_text(errors="replace")
        match = re.search(pattern, content)
        if match:
            return match.group(1)
        if process.poll() is not None:
            raise RuntimeError(f"Test process exited {process.returncode}: {content[-2000:]}")
        time.sleep(0.1)
    raise RuntimeError("Test server startup timed out")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--jar", type=Path, default=ROOT / "backend/target/hostai-backend-0.1.0.jar"
    )
    parser.add_argument("--java", default="java")
    parser.add_argument("--pebby-root", type=Path)
    parser.add_argument(
        "--ui-test",
        action="store_true",
        help="Also verify Pebby's UI on the repository's isolated test display",
    )
    args = parser.parse_args()
    if args.ui_test and not args.pebby_root:
        parser.error("--ui-test requires --pebby-root")
    processes, logs = [], []
    server = thread = None
    with tempfile.TemporaryDirectory(prefix="hostai-sdk-smoke-") as directory:
        temp = Path(directory)
        # Only explicit configuration enters test subprocesses; no real gateway state.
        env = {"PATH": os.environ["PATH"], "PYTHONDONTWRITEBYTECODE": "1"}
        try:
            if args.pebby_root:
                pebby = args.pebby_root.resolve(strict=True)
                log_path = temp / "provider.log"
                log = log_path.open("w")
                logs.append(log)
                code = "from pathlib import Path; import sys; from inference import Engine; from serve import make_server; s=make_server(Engine(Path(sys.argv[1])),0); print(f'ORIGIN=http://127.0.0.1:{s.server_port}',flush=True); s.serve_forever()"
                provider_process = subprocess.Popen(
                    [str(pebby / ".venv/bin/python"), "-c", code, str(temp / "absent.pt")],
                    cwd=pebby,
                    env=env,
                    stdout=log,
                    stderr=log,
                )
                processes.append(provider_process)
                provider_origin = wait_log(
                    provider_process, log_path, r"ORIGIN=(http://127\.0\.0\.1:\d+)"
                )
                model, payload = "pebby:latest", {"op": "info"}
            else:
                ui = temp / "ui"
                ui.mkdir()
                (ui / "index.html").write_text(
                    '<!doctype html><script src="hostai-bridge.js"></script>'
                )
                contract = Interaction(
                    "Echo a string; requests are independent.",
                    {"type": "string", "description": "Text to echo."},
                    {"type": "string", "description": "Unchanged text."},
                    [{"description": "Echo", "input": "hello", "output": "hello"}],
                )
                provider = Provider(
                    "sdk-echo",
                    [Model("sdk-echo:latest", lambda value: value, contract)],
                    CustomUI(ui),
                )
                server = ThreadingHTTPServer(("127.0.0.1", 0), provider.handler())
                thread = threading.Thread(target=server.serve_forever)
                thread.start()
                provider_origin = f"http://127.0.0.1:{server.server_port}"
                model, payload = "sdk-echo:latest", "hello"

            log_path = temp / "gateway.log"
            log = log_path.open("w")
            logs.append(log)
            gateway = subprocess.Popen(
                [
                    args.java,
                    "-jar",
                    str(args.jar.resolve(strict=True)),
                    "--server.port=0",
                    "--hostai.guest-port=0",
                    "--hostai.openai-urls=",
                    f"--hostai.runtime-urls={provider_origin}",
                    f"--hostai.access-directory={temp / 'access'}",
                ],
                cwd=ROOT,
                env=env,
                stdout=log,
                stderr=log,
            )
            processes.append(gateway)
            origin = "http://127.0.0.1:" + wait_log(
                gateway, log_path, r"Netty started on port (\d+)"
            )

            def cli(*arguments, guest_origin=None, token=None, success=True):
                cli_env = dict(env)
                if token:
                    cli_env["HOSTAI_ACCESS_TOKEN"] = token
                result = subprocess.run(
                    [
                        "node",
                        str(ROOT / "scripts/hostai.mjs"),
                        *arguments,
                        "--url",
                        guest_origin or origin,
                    ],
                    env=cli_env,
                    capture_output=True,
                    text=True,
                    timeout=20,
                )
                if success:
                    assert result.returncode == 0, result.stderr
                else:
                    assert result.returncode != 0
                return result.stdout

            catalog = json.loads(cli("models", "--json"))
            selected = next(item for item in catalog["models"] if item["name"] == model)
            assert selected["capabilities"] == {"chat": False, "infer": True}
            description = json.loads(cli("describe", model, "--json"))
            assert description["infer"]["inputSchema"] == selected["interaction"]["inputSchema"]
            expected = json_request(
                provider_origin, "/hostai/infer", {"model": model, "input": payload}
            )
            if args.pebby_root:
                assert expected["agent"]["loaded"] is False, (
                    "No learned-policy execution is allowed in this smoke test"
                )
            records = [
                json.loads(line) for line in cli("infer", model, json.dumps(payload)).splitlines()
            ]
            assert records == [{"event": expected, "done": True}]
            print(
                "PASS installed provider → Java gateway → headless CLI discovery/inference",
                flush=True,
            )

            session = json_request(
                origin, "/api/sharing/start", {"model": model, "hostLabel": "SDK smoke test"}
            )
            grant = json_request(
                origin, "/api/sharing/grants", {"label": "Fixture", "expiresInHours": 1}
            )
            guest = session["guestUrl"]
            guest_args = {"guest_origin": guest, "token": grant["token"]}
            guest_description = json.loads(
                cli("describe", model, "--guest", "--json", **guest_args)
            )
            assert (
                guest_description["infer"]["inputSchema"] == selected["interaction"]["inputSchema"]
            )
            assert [
                json.loads(line)
                for line in cli(
                    "infer", model, json.dumps(payload), "--guest", **guest_args
                ).splitlines()
            ] == records
            json_request(origin, "/api/sharing/stop", {})
            cli("infer", model, json.dumps(payload), "--guest", success=False, **guest_args)
            print("PASS local guest docs/inference and stop-access rejection", flush=True)

            # Headless checks above are complete before requesting any UI assets.
            metadata = selected["ui"]
            with urlopen(
                f"{origin}/api/model-ui/{metadata['runtime']}/{metadata['entry']}", timeout=10
            ) as response:
                assert b"hostai-bridge.js" in response.read()
                assert "connect-src 'none'" in response.headers["Content-Security-Policy"]
            print(
                "PASS real provider UI HTML through gateway sandbox headers (HTTP-only, not a visual test)",
                flush=True,
            )
            if args.ui_test:
                log_path = temp / "web.log"
                log = log_path.open("w")
                logs.append(log)
                web = subprocess.Popen(
                    ["node", "apps/web/server.mjs"],
                    cwd=ROOT,
                    env={**env, "HOSTAI_UI_PORT": "0", "HOSTAI_BACKEND_URL": origin},
                    stdout=log,
                    stderr=log,
                )
                processes.append(web)
                web_origin = wait_log(web, log_path, r"HostAI workspace: (http://127\.0\.0\.1:\d+)")
                browser_test = subprocess.Popen(
                    ["/usr/bin/python3", "scripts/test-ui.py", "pebby-sdk.spec.ts"],
                    cwd=ROOT,
                    env={**env, "HOSTAI_TEST_URL": web_origin, "HOSTAI_PEBBY": "sdk"},
                )
                processes.append(browser_test)
                assert browser_test.wait() == 0, "Isolated provider UI test failed"
        finally:
            for process in reversed(processes):
                if process.poll() is None:
                    process.terminate()
                    try:
                        process.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait(timeout=5)
                assert process.poll() is not None
            if server:
                server.shutdown()
                server.server_close()
                thread.join(timeout=5)
                assert not thread.is_alive()
            for log in logs:
                log.close()


if __name__ == "__main__":
    main()
