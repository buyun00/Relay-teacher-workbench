"""Private LAN bridge into the existing Hermes container; no container restart/socket mount."""
import argparse
import json
import os
import signal
import socket
import subprocess
import threading

p = argparse.ArgumentParser()
p.add_argument("--container", default="hermes-agent")
p.add_argument("--host", required=True)
p.add_argument("--port", type=int, default=8767)
p.add_argument("--profile", default="/opt/data/profiles/teacher-workbench")
args = p.parse_args()
plugin = args.profile + "/plugins/teacher-workbench"
pid_file = args.profile + "/recording-receiver.pid"
details = json.loads(subprocess.check_output(["docker", "inspect", args.container]))[0]
networks = details["NetworkSettings"]["Networks"]
address = next(n["IPAddress"] for n in networks.values() if n["IPAddress"])
if not os.environ.get("HERMES_UPLOADER_TOKEN"):
    raise SystemExit("HERMES_UPLOADER_TOKEN is required")

listener = socket.socket()
listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
listener.bind((args.host, args.port))
listener.listen(32)
listener.settimeout(1)
stopped = threading.Event()

def stop(*_args):
    stopped.set()

signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
child = subprocess.Popen(["docker", "exec", "--user", "hermes", "-e", "HERMES_HOME=" + args.profile,
    "-e", "HERMES_UPLOADER_TOKEN", "-w", plugin, args.container,
    "/opt/hermes/.venv/bin/python", "-m", "workbench.ingress", "--host", "0.0.0.0",
    "--port", str(args.port), "--auto-process", "--pid-file", pid_file])

def forward(source, target):
    try:
        while not stopped.is_set():
            data = source.recv(65536)
            if not data:
                break
            target.sendall(data)
    except OSError:
        pass
    finally:
        try: target.shutdown(socket.SHUT_WR)
        except OSError: pass

def proxy(client):
    try:
        upstream = socket.create_connection((address, args.port), timeout=10)
        with client, upstream:
            client.settimeout(90)
            upstream.settimeout(90)
            thread = threading.Thread(target=forward, args=(client, upstream), daemon=True)
            thread.start()
            forward(upstream, client)
    except OSError:
        client.close()

try:
    while not stopped.is_set() and child.poll() is None:
        try:
            client, _ = listener.accept()
            threading.Thread(target=proxy, args=(client,), daemon=True).start()
        except socket.timeout:
            pass
finally:
    intentional_stop = stopped.is_set()
    stopped.set()
    listener.close()
    # Stop only this receiver, verifying the PID is still the recorded module.
    script = "import os,signal;from pathlib import Path;p=Path(" + repr(pid_file) + ");" \
        "pid=int(p.read_text()) if p.exists() else 0;" \
        "cmd=Path('/proc/'+str(pid)+'/cmdline').read_bytes() if pid and Path('/proc/'+str(pid)).exists() else b'';" \
        "os.kill(pid,signal.SIGTERM) if b'workbench.ingress' in cmd else None"
    subprocess.run(["docker", "exec", "--user", "hermes", args.container,
                    "/opt/hermes/.venv/bin/python", "-c", script], timeout=20, check=False)
    try: child.wait(timeout=30)
    except subprocess.TimeoutExpired: child.terminate()
raise SystemExit(0 if intentional_stop else (child.returncode or 1))
