"""
mitmdump addon: Capture Cursor IDE <-> api2.cursor.sh agent protocol traffic.

Usage:
  mitmdump -s scripts/cursor-capture.py -p 8080

Captures RunSSE/BidiAppend request bodies and response bodies to captures/.
Forces non-streaming mode for agent API requests to ensure body capture.
"""

import os
import json
import time
from mitmproxy import http, ctx

CAPTURE_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "captures")
AGENT_PATHS = {
    "/agent.v1.AgentService/RunSSE",
    "/agent.v1.AgentService/BidiAppend",
}
INTERESTING_PATHS = AGENT_PATHS | {
    "/aiserver.v1.AiserverService/StreamChat",
}
TARGET_HOST = "api2.cursor.sh"

_counter = 0


def _next_id():
    global _counter
    _counter += 1
    return _counter


def _ensure_dir():
    os.makedirs(CAPTURE_DIR, exist_ok=True)


def _save(prefix, seq, suffix, data):
    _ensure_dir()
    fname = f"{prefix}_{seq:04d}_{suffix}"
    fpath = os.path.join(CAPTURE_DIR, fname)
    mode = "wb" if isinstance(data, bytes) else "w"
    with open(fpath, mode) as f:
        f.write(data)
    ctx.log.info(f"[capture] Saved {fpath} ({len(data)} bytes)")


class CursorCapture:
    """Addon class to handle streaming interception properly."""

    def requestheaders(self, flow: http.HTTPFlow):
        """Disable streaming for agent API requests to capture full body."""
        if flow.request.pretty_host != TARGET_HOST:
            return
        if flow.request.path in INTERESTING_PATHS:
            flow.request.stream = False

    def responseheaders(self, flow: http.HTTPFlow):
        """Disable response streaming for agent API to capture full body."""
        if flow.request.pretty_host != TARGET_HOST:
            return
        if flow.request.path in INTERESTING_PATHS:
            flow.response.stream = False

    def request(self, flow: http.HTTPFlow):
        if flow.request.pretty_host != TARGET_HOST:
            return
        if flow.request.path not in INTERESTING_PATHS:
            return

        seq = _next_id()
        path_tag = flow.request.path.rsplit("/", 1)[-1]

        flow.metadata["capture_seq"] = seq
        flow.metadata["capture_path_tag"] = path_tag

        headers_dict = dict(flow.request.headers)
        auth = headers_dict.get("authorization", "")
        if auth:
            parts = auth.split(" ", 1)
            if len(parts) == 2 and len(parts[1]) > 40:
                token = parts[1]
                headers_dict["authorization"] = f"{parts[0]} {token[:20]}...({len(token)} chars)"

        meta = {
            "timestamp": int(time.time()),
            "method": flow.request.method,
            "url": flow.request.pretty_url,
            "path": flow.request.path,
            "path_tag": path_tag,
            "headers": headers_dict,
            "content_length": len(flow.request.content) if flow.request.content else 0,
        }

        _save(f"req_{path_tag}", seq, "meta.json", json.dumps(meta, indent=2, ensure_ascii=False))

        if flow.request.content:
            _save(f"req_{path_tag}", seq, "body.bin", flow.request.content)
            ctx.log.info(
                f"[capture] #{seq} REQUEST {path_tag} "
                f"body={len(flow.request.content)} bytes"
            )
        else:
            ctx.log.info(f"[capture] #{seq} REQUEST {path_tag} (no body)")

    def response(self, flow: http.HTTPFlow):
        if flow.request.pretty_host != TARGET_HOST:
            return
        if flow.request.path not in INTERESTING_PATHS:
            return

        seq = flow.metadata.get("capture_seq", _next_id())
        path_tag = flow.metadata.get("capture_path_tag", "unknown")

        resp_headers = dict(flow.response.headers) if flow.response else {}
        body = flow.response.content if flow.response and flow.response.content else b""

        resp_meta = {
            "status_code": flow.response.status_code if flow.response else None,
            "headers": resp_headers,
            "content_length": len(body),
        }

        _save(f"resp_{path_tag}", seq, "meta.json", json.dumps(resp_meta, indent=2, ensure_ascii=False))

        if body:
            _save(f"resp_{path_tag}", seq, "body.bin", body)
            ctx.log.info(
                f"[capture] #{seq} RESPONSE {path_tag} "
                f"status={resp_meta['status_code']} body={len(body)} bytes"
            )
        else:
            ctx.log.info(
                f"[capture] #{seq} RESPONSE {path_tag} "
                f"status={resp_meta['status_code']} (no body)"
            )


addons = [CursorCapture()]
