#!/usr/bin/env python3
"""Linux UI tests on a proved-private Sway display, never the live desktop."""
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]
runtime = Path(tempfile.mkdtemp(prefix='hai-'))
processes = []
evidence = ROOT / 'test-results'
evidence.mkdir(exist_ok=True)
base_env = {'PATH': '/usr/bin:/bin'}


def descendants(pid):
    children = Path(f'/proc/{pid}/task/{pid}/children')
    if not children.exists():
        return []
    result = [int(value) for value in children.read_text().split()]
    return result + [child for parent in result for child in descendants(parent)]


def owned_pids():
    # A worker can outlive its process-group leader and be reparented. Descendant
    # traversal alone loses that worker once the leader exits.
    groups = {process.pid for process in processes}
    result = {pid for process in processes for pid in [process.pid, *descendants(process.pid)]}
    for entry in Path('/proc').iterdir():
        if not entry.name.isdigit():
            continue
        pid = int(entry.name)
        try:
            if os.getpgid(pid) in groups:
                result.add(pid)
        except ProcessLookupError:
            pass
    return result


def sandbox(env, writable_repo=False):
    args = ['bwrap', '--ro-bind', '/', '/', '--dev', '/dev', '--tmpfs', '/run',
            '--tmpfs', '/tmp', '--bind', str(runtime), str(runtime),
            '--unshare-pid', '--die-with-parent', '--proc', '/proc', '--clearenv']
    if writable_repo:
        args += ['--bind', str(ROOT), str(ROOT),
                 '--ro-bind', str(runtime / 'resolv.conf'), str(resolver_target)]
    for key, value in env.items():
        args += ['--setenv', key, value]
    return args


try:
    for name in ['sway', 'swaymsg', 'bwrap', 'grim', 'chromium', 'wtype', 'wl-paste']:
        if not shutil.which(name):
            raise RuntimeError(f'{name} is required for isolated UI verification.')
    version = subprocess.check_output(['sway', '--version'], text=True).strip()
    if version != 'sway version 1.12':
        raise RuntimeError(f'Verify the isolation setup for {version} before updating this guard.')
    for name in ['run', 'home', 'cache', 'config', 'data']:
        (runtime / name).mkdir(mode=0o700)
    # /run stays private. Give test clients only a snapshot of DNS configuration,
    # including when /etc/resolv.conf points into systemd-resolved's hidden /run.
    # No service directory, session bus, logind or resolver control socket is mounted.
    resolver_target = Path('/etc/resolv.conf').resolve(strict=True)
    if str(resolver_target) not in ['/etc/resolv.conf', '/run/systemd/resolve/stub-resolv.conf',
                                    '/run/systemd/resolve/resolv.conf']:
        raise RuntimeError('Verify the resolver file mount for this machine before testing.')
    shutil.copyfile('/etc/resolv.conf', runtime / 'resolv.conf')
    shutil.copyfile('/usr/bin/sway', runtime / 'sway')
    (runtime / 'sway').chmod(0o700)
    if subprocess.check_output(['getcap', str(runtime / 'sway')], text=True).strip():
        raise RuntimeError('The copied compositor must not have capabilities.')
    (runtime / 'sway.conf').write_text('output HEADLESS-1 mode 1440x1100@60Hz\nxwayland disable\nseat seat0 fallback true\ndefault_border none\n')
    env = {**base_env, 'HOME': str(runtime / 'home'), 'XDG_RUNTIME_DIR': str(runtime / 'run'),
           'XDG_CACHE_HOME': str(runtime / 'cache'), 'XDG_CONFIG_HOME': str(runtime / 'config'),
           'XDG_DATA_HOME': str(runtime / 'data')}
    with (runtime / 'sway.log').open('w') as log:
        compositor = subprocess.Popen(sandbox({**env, 'WLR_BACKENDS': 'headless', 'WLR_RENDERER': 'pixman',
                                               'WLR_HEADLESS_OUTPUTS': '1', 'LIBSEAT_BACKEND': 'noop'}) +
                                     [str(runtime / 'sway'), '--unsupported-gpu', '-c', str(runtime / 'sway.conf'), '-d'],
                                     env=base_env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    processes.append(compositor)
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        sockets = list((runtime / 'run').glob('sway-ipc.*.sock'))
        if sockets and compositor.poll() is None:
            break
        if compositor.poll() is not None:
            raise RuntimeError((runtime / 'sway.log').read_text())
        time.sleep(0.1)
    else:
        raise RuntimeError('Private compositor did not start.')
    pids = descendants(compositor.pid)
    actual = next(pid for pid in pids if Path(f'/proc/{pid}/exe').resolve() == runtime / 'sway')
    observed = Path(f'/proc/{actual}/environ').read_bytes().decode().split('\0')
    assert 'WLR_BACKENDS=headless' in observed and 'WLR_RENDERER=pixman' in observed
    assert not any(x.startswith(('DISPLAY=', 'WAYLAND_DISPLAY=', 'WAYLAND_SOCKET=', 'DBUS_SESSION_BUS_ADDRESS=', 'HYPRLAND_INSTANCE_SIGNATURE=')) for x in observed)
    descriptors = [os.readlink(fd) for fd in Path(f'/proc/{actual}/fd').iterdir()]
    assert not any(x.startswith(('/dev/dri', '/dev/input', '/dev/tty', '/dev/uinput')) for x in descriptors)
    for forbidden in ['dev/dri', 'dev/input', 'dev/uinput', 'run/dbus', 'run/seatd.sock', 'run/systemd']:
        assert not Path(f'/proc/{actual}/root/{forbidden}').exists()
    outputs = json.loads(subprocess.check_output(['swaymsg', '-s', str(sockets[0]), '-t', 'get_outputs', '-r'], env=base_env))
    assert len(outputs) == 1 and outputs[0]['name'] == 'HEADLESS-1'
    assert 'Creating pixman renderer' in (runtime / 'sway.log').read_text()
    (evidence / 'isolation.json').write_text(json.dumps({'version': version, 'pid': actual, 'environment': observed, 'fds': descriptors, 'outputs': outputs}, indent=2))
    wayland = next(p.name for p in (runtime / 'run').glob('wayland-*') if not p.name.endswith('.lock'))
    test_env = {**env, 'WAYLAND_DISPLAY': wayland, 'HOSTAI_TEST_DISPLAY_PROVED': '1'}
    for key in ['HOSTAI_TEST_URL', 'HOSTAI_INTEGRATION', 'HOSTAI_GUEST_TEST_URL', 'HOSTAI_DIRECTORY_TEST_URL', 'HOSTAI_RENDER_BENCH', 'DEBUG']:
        if key in os.environ:
            test_env[key] = os.environ[key]
    node = '/usr/bin/node'
    runner = ROOT / 'apps/web/node_modules/@playwright/test/cli.js'
    # Prove the client sandbox has only the copied resolver file under /run/systemd.
    subprocess.run(sandbox(test_env, writable_repo=True) + ['/usr/bin/python3', '-c',
        'from pathlib import Path; '
        'assert Path("/etc/resolv.conf").is_file(); '
        'assert not any(Path(p).exists() for p in ["/run/dbus", "/run/seatd.sock", "/run/systemd/private", "/run/systemd/seats", "/dev/dri", "/dev/input"]); '
        'assert all(p.is_dir() or str(p) in ["/run/systemd/resolve/stub-resolv.conf", "/run/systemd/resolve/resolv.conf"] for p in Path("/run/systemd").rglob("*"))'],
        cwd=ROOT, env=base_env, check=True, timeout=5)
    command = sandbox(test_env, writable_repo=True) + [node, str(runner), 'test', '--config', 'apps/web/playwright.config.ts', *sys.argv[1:]]
    tests = subprocess.Popen(command, cwd=ROOT, env=base_env, start_new_session=True)
    processes.append(tests)
    code = tests.wait()
    if (runtime / 'electron-overview.png').exists():
        shutil.copyfile(runtime / 'electron-overview.png', evidence / 'electron-overview.png')
    sys.exit(code)
finally:
    captured = owned_pids()
    if 'sockets' in globals() and sockets:
        try:
            subprocess.run(['swaymsg', '-s', str(sockets[0]), 'exit'], env=base_env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5)
        except (OSError, subprocess.TimeoutExpired):
            pass  # Exact process-group cleanup below remains mandatory.
    for process in reversed(processes):
        # Signal our exact group even when its original leader already exited.
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        if process.poll() is None:
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait(timeout=5)
    deadline = time.monotonic() + 5
    remaining = captured
    while remaining and time.monotonic() < deadline:
        remaining = [pid for pid in captured if Path(f'/proc/{pid}').exists()]
        if remaining:
            time.sleep(0.1)
    if remaining:
        for process in reversed(processes):
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        deadline = time.monotonic() + 5
        while remaining and time.monotonic() < deadline:
            remaining = [pid for pid in captured if Path(f'/proc/{pid}').exists()]
            if remaining:
                time.sleep(0.1)
        if remaining:
            print(f'Test process cleanup incomplete: {remaining}', file=sys.stderr)
            sys.exit(1)
    shutil.rmtree(runtime)
