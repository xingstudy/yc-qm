import argparse
import http.server
import os
import subprocess
import threading

parser = argparse.ArgumentParser()
parser.add_argument("binary")
args = parser.parse_args()
requests = []


class S3Handler(http.server.BaseHTTPRequestHandler):
    def do_PUT(self):
        if self.headers.get("Transfer-Encoding") == "chunked":
            chunks = []
            while True:
                size = int(self.rfile.readline().strip().split(b";")[0], 16)
                if size == 0:
                    while self.rfile.readline().strip():
                        pass
                    break
                chunks.append(self.rfile.read(size))
                self.rfile.read(2)
            body = b"".join(chunks)
        else:
            body = self.rfile.read(int(self.headers["Content-Length"]))
        requests.append(("PUT", self.path, body))
        self.send_response(200)
        self.send_header("ETag", '"fixture"')
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_DELETE(self):
        requests.append(("DELETE", self.path))
        self.send_response(204)
        self.end_headers()

    def log_message(self, *values):
        pass


server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), S3Handler)
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()
env = dict(
    os.environ,
    AWS_ACCESS_KEY_ID="fixture-access-key",
    AWS_SECRET_ACCESS_KEY="fixture-secret-key",
    AWS_DEFAULT_REGION="us-east-1",
    AWS_EC2_METADATA_DISABLED="true",
    AWS_REQUEST_CHECKSUM_CALCULATION="when_required",
    AWS_CONFIG_FILE=os.devnull,
    AWS_SHARED_CREDENTIALS_FILE=os.devnull,
)
env.pop("AWS_SESSION_TOKEN", None)
env.pop("AWS_PROFILE", None)
endpoint = f"http://127.0.0.1:{server.server_port}"
try:
    subprocess.run([args.binary, "--version"], env=env, check=True)
    common = [args.binary, "--endpoint-url", endpoint, "--no-cli-pager", "s3"]
    subprocess.run([*common, "cp", "-", "s3://fixture/.write-probe"], input=b"ok", env=env, check=True, timeout=20)
    subprocess.run([*common, "rm", "s3://fixture/.write-probe"], env=env, check=True, timeout=20)
    assert requests == [("PUT", "/fixture/.write-probe", b"ok"), ("DELETE", "/fixture/.write-probe")], requests
finally:
    server.shutdown()
    server.server_close()
    thread.join()
print("AWS CLI S3 stdin upload and delete passed against the local HTTP fixture")
