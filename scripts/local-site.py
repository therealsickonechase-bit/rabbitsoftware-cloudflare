"""Serve the public static site and an explicit loopback-only Ollama chat mode."""

import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener


SITE = Path(__file__).resolve().parents[1] / "site"
MAX_BODY = 65536


class NoRedirects(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise URLError("Local model redirects are not allowed.")


local_open = build_opener(ProxyHandler({}), NoRedirects()).open


def validate_messages(payload):
    if not isinstance(payload, dict) or set(payload) - {"messages", "max_tokens", "temperature"}:
        raise ValueError("Expected a chat request with messages and optional generation settings.")
    messages = payload.get("messages")
    if not isinstance(messages, list) or not 1 <= len(messages) <= 8:
        raise ValueError("Provide 1-8 bounded chat messages.")
    for message in messages:
        if not isinstance(message, dict) or set(message) != {"role", "content"}:
            raise ValueError("Each message needs only role and content.")
        if message["role"] not in ("system", "user", "assistant"):
            raise ValueError("Unsupported message role.")
        if not isinstance(message["content"], str) or not 1 <= len(message["content"]) <= 12000:
            raise ValueError("Messages must contain 1-12000 characters.")
    return messages


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, model, **kwargs):
        self.model = model
        super().__init__(*args, directory=str(SITE), **kwargs)

    def json_response(self, status, payload):
        raw = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_POST(self):
        port = self.server.server_address[1]
        hosts = {f"127.0.0.1:{port}", f"localhost:{port}"}
        host = self.headers.get("Host")
        if host not in hosts or self.headers.get("Origin") != f"http://{host}":
            self.json_response(403, {"error": "Only same-origin loopback website requests are allowed."})
            return
        if self.path != "/api/local-chat":
            self.json_response(404, {"error": "Unknown local endpoint."})
            return
        if self.headers.get("Content-Type", "").split(";")[0].strip() != "application/json":
            self.json_response(415, {"error": "Use application/json."})
            return
        if self.headers.get("Transfer-Encoding"):
            self.json_response(400, {"error": "Chunked requests are not supported."})
            return
        try:
            size = int(self.headers.get("Content-Length", "0"))
            if not 0 < size <= MAX_BODY:
                self.json_response(413, {"error": "Request must be between 1 and 65536 bytes."})
                return
            payload = json.loads(self.rfile.read(size))
            messages = validate_messages(payload)
        except (ValueError, UnicodeError) as error:
            self.json_response(400, {"error": str(error)})
            return
        request = Request(
            "http://127.0.0.1:11434/api/chat",
            data=json.dumps({
                "model": self.model, "messages": messages, "stream": False,
                "options": {"num_predict": 380, "temperature": 0.2},
            }).encode("utf-8"),
            headers={"Content-Type": "application/json"},
        )
        try:
            with local_open(request, timeout=120) as response:
                raw = response.read(MAX_BODY + 1)
            if len(raw) > MAX_BODY:
                raise ValueError("Local model response exceeds the size limit.")
            answer = json.loads(raw)
            if not isinstance(answer, dict) or not isinstance(answer.get("message"), dict):
                raise ValueError("Invalid local model response.")
            content = answer.get("message", {}).get("content")
            if not isinstance(content, str) or not content.strip():
                raise ValueError("Local model returned no answer.")
        except (HTTPError, URLError, OSError, ValueError) as error:
            self.log_error("Local model request failed: %s", error)
            self.json_response(502, {"error": "Local model failed or is unavailable. "
                                    "Start Ollama and install the selected model. "
                                    "No hosted fallback was attempted."})
            return
        self.json_response(200, {
            "model": self.model, "choices": [{"message": {"content": content}}],
        })


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8788)
    parser.add_argument("--model", default="qwen2.5:3b")
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error("Port must be between 1 and 65535.")
    server = ThreadingHTTPServer(("127.0.0.1", args.port), partial(Handler, model=args.model))
    print(f"Local website: http://127.0.0.1:{args.port}/; Ollama model: {args.model}", flush=True)
    print("No hosted AI fallback. Keep this server on loopback; Ctrl+C stops it.", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
