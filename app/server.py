"""Local dev server that sets headers to bypass ngrok's browser warning."""
import http.server
import sys


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("ngrok-skip-browser-warning", "true")
        self.send_header("Access-Control-Allow-Origin", "*")
        super().end_headers()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    with http.server.HTTPServer(("", port), Handler) as s:
        print(f"Serving on http://localhost:{port}")
        s.serve_forever()
