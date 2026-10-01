# /// script
# dependencies = ["pyte"]
# ///
# Run with: uv run ui.test.py
# Set NIMINAL_BIN to test a different build.
import fcntl
import json
import os
import pathlib
import pty
import select
import shutil
import struct
import subprocess
import tempfile
import termios
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pyte

repo = pathlib.Path(__file__).resolve().parents[3]
binary = pathlib.Path(os.environ.get("NIMINAL_BIN", repo / "niminal/build/dev/niminal"))
requests = []


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        data = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        requests.append(data)
        side = any(
            "side questions" in str(m.get("content", "")) for m in data["messages"]
        )
        response = "SIDE ANSWER marker" if side else "MAIN ANSWER marker"
        if side:
            time.sleep(0.5)
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        for delta, reason in [
            ({"role": "assistant", "content": response}, None),
            ({}, "stop"),
        ]:
            value = {
                "id": "test",
                "object": "chat.completion.chunk",
                "model": "test",
                "choices": [{"index": 0, "delta": delta, "finish_reason": reason}],
            }
            self.wfile.write(("data: " + json.dumps(value) + "\n\n").encode())
            self.wfile.flush()
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()


server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
with tempfile.TemporaryDirectory(prefix="niminal-btw-ui-") as root:
    root = pathlib.Path(root)
    home = root / "home"
    home.mkdir()
    work = root / "work"
    work.mkdir()
    config = home / ".niminal"
    config.mkdir()
    shutil.copytree(
        repo / "extensions_and_tools/extensions/btw", config / "extensions/btw"
    )
    (config / "models.json").write_text(
        json.dumps(
            {
                "models": [
                    {
                        "provider": "local",
                        "name": "test",
                        "runtime": "llamacpp",
                        "model": "test",
                        "api_url": f"http://127.0.0.1:{server.server_port}/v1/chat/completions",
                        "context_window": 32768,
                    }
                ]
            }
        )
    )
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 45, 110, 0, 0))
    env = dict(os.environ, HOME=str(home), TERM="xterm-256color")
    child = subprocess.Popen(
        [str(binary), "--provider", "local", "--model", "test", "--no-context-files"],
        cwd=work,
        env=env,
        stdin=slave,
        stdout=slave,
        stderr=slave,
        start_new_session=True,
    )
    os.close(slave)
    screen = pyte.Screen(110, 45)
    stream = pyte.Stream(screen)
    raw = []

    def pump(duration=0.2):
        end = time.monotonic() + duration
        while time.monotonic() < end:
            if select.select([master], [], [], 0.05)[0]:
                data = os.read(master, 65536)
                raw.append(data)
                if b"\x1b[6n" in data:
                    os.write(master, b"\x1b[1;1R")
                stream.feed(data.decode(errors="replace"))

    def text():
        return "\n".join(screen.display)

    def wait_for(marker, timeout=8):
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            pump()
            if marker in text():
                return
            if child.poll() is not None:
                break
        raise AssertionError(f"Missing {marker!r}:\n{text()}")

    def send(value):
        os.write(master, value.encode())
        pump()

    try:
        wait_for("describe a change")
        send("Main context marker\r")
        wait_for("MAIN ANSWER marker")
        send("/btw\r")
        wait_for("ask a side question")
        wait_for("[Close]")
        send("Side question marker\r")
        wait_for("SIDE ANSWER marker")
        assert "Main context marker" in str(requests[1]["messages"])
        send("Followup marker\r")
        end = time.monotonic() + 5
        while len(requests) < 3 and time.monotonic() < end:
            pump()
        assert len(requests) == 3, len(requests)
        assert "SIDE ANSWER marker" in str(requests[2]["messages"])
        send("\x1b")
        pump(0.7)
        assert "[Close]" not in text(), text()
        send("/btw\r")
        wait_for("ask a side question")
        assert "Side question marker" not in text(), text()
        send("\x1b")
        pump(0.5)
        send("Main followup marker\r")
        pump(1)
        assert len(requests) == 4, len(requests)
        assert "Side question marker" not in str(requests[3]["messages"])
        assert "Followup marker" not in str(requests[3]["messages"])
        assert "SIDE ANSWER marker" not in str(requests[3]["messages"])
        send("\tTab draft marker")
        wait_for("Tab draft marker", 2)
        print(
            "PASS: modal chat, follow-ups, reset, isolated main context, and composer focus after closing"
        )
    finally:
        child.terminate()
        try:
            child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait()
        os.close(master)
        server.shutdown()
