import argparse
import signal
import sqlite3
import subprocess
import tempfile
import time
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("binary")
parser.add_argument("--source-binary")
args = parser.parse_args()

with tempfile.TemporaryDirectory(prefix="qm-litestream-") as directory:
    root = Path(directory)
    database = root / "app.db"
    replica = root / "replica"
    config = root / "litestream.yml"
    config.write_text(f"dbs:\n  - path: {database}\n    replicas:\n      - type: file\n        path: {replica}\n")
    with sqlite3.connect(database) as connection:
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("CREATE TABLE entries (value TEXT)")
        connection.execute("INSERT INTO entries VALUES ('before-start')")
    with (root / "replication.log").open("w+") as log:
        process = subprocess.Popen(
            [args.source_binary or args.binary, "replicate", "-config", str(config)],
            stdout=log,
            stderr=subprocess.STDOUT,
        )
        try:
            deadline = time.monotonic() + 30
            while not list(replica.glob("generations/*/snapshots/*")):
                if process.poll() is not None or time.monotonic() > deadline:
                    log.seek(0)
                    raise AssertionError(log.read())
                time.sleep(0.2)
            with sqlite3.connect(database) as connection:
                connection.execute("INSERT INTO entries VALUES ('after-start')")
            time.sleep(3)
        finally:
            process.send_signal(signal.SIGTERM)
            process.wait(timeout=15)
        assert process.returncode == 0
    subprocess.run([args.binary, "snapshots", "-config", str(config), str(database)], check=True)
    database.unlink()
    for suffix in ["-wal", "-shm"]:
        Path(f"{database}{suffix}").unlink(missing_ok=True)
    command = [args.binary, "restore", "-config", str(config), "-if-replica-exists", "-if-db-not-exists", str(database)]
    subprocess.run(command, check=True)
    with sqlite3.connect(database) as connection:
        assert connection.execute("SELECT value FROM entries ORDER BY rowid").fetchall() == [
            ("before-start",),
            ("after-start",),
        ]
        assert connection.execute("PRAGMA integrity_check").fetchone() == ("ok",)
    subprocess.run(command, check=True)
print("Litestream v0.3 snapshot, WAL recovery, and existing-database protection passed")
