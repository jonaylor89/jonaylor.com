"""Exercise bootstrap without a Linux host, Docker daemon, or real media."""

import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


class BootstrapTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.media = self.root / "media"
        self.media.mkdir()
        (self.media / ".media-root").touch()
        self.appdata = self.root / "appdata"
        self.log = self.root / "docker.log"
        source = Path(__file__).resolve().parent
        for name in ("bootstrap.sh", "compose.yml"):
            shutil.copy(source / name, self.root / name)
        self.values = {
            "APPDATA_DIR": str(self.appdata),
            "MEDIA_DIR": str(self.media),
            "MEDIA_MOUNT": str(self.media),
            "PUID": str(os.getuid()),
            "PGID": str(os.getgid()),
            "TZ": "Etc/UTC",
            "BIND_ADDRESS": "127.0.0.1",
        }
        self.env = dict(os.environ, PATH=f"{self.bin}:{os.environ['PATH']}")
        # macOS realpath lacks GNU -m; emulate only path canonicalization here.
        realpath = self.bin / "realpath"
        realpath.write_text(
            f"#!{sys.executable}\nimport os, sys\nprint(os.path.realpath(sys.argv[-1]))\n"
        )
        realpath.chmod(0o755)
        self.mock("uname", "echo Linux")
        self.mock("mountpoint", "exit 0")
        self.mock("findmnt", f"printf '%s\\n' '{self.media}'")
        self.mock("docker", f'printf "%s\\n" "$*" >> "{self.log}"')

    def mock(self, name, body):
        path = self.bin / name
        path.write_text(f"#!/bin/sh\n{body}\n")
        path.chmod(0o755)

    def run_script(self, *args, extra=""):
        (self.root / ".env").write_text(
            "".join(f"{key}={value}\n" for key, value in self.values.items()) + extra
        )
        return subprocess.run(
            ["bash", str(self.root / "bootstrap.sh"), *args],
            env=self.env, capture_output=True, text=True, check=False,
        )

    def test_default_only_checks(self):
        result = self.run_script()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(self.appdata.exists())
        self.assertNotIn("up -d", self.log.read_text())

    def test_start_is_repeatable(self):
        for _ in range(2):
            result = self.run_script("--start")
            self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((self.appdata / "jellyfin/config").is_dir())
        self.assertTrue((self.media / "music").is_dir())
        self.assertTrue((self.media / "downloads").is_dir())
        self.assertEqual(self.log.read_text().count("up -d"), 2)

    def test_missing_marker_refuses_start(self):
        (self.media / ".media-root").unlink()
        self.assertNotEqual(self.run_script("--start").returncode, 0)
        self.assertFalse(self.appdata.exists())

    def test_unmounted_storage_refuses_start(self):
        self.mock("mountpoint", "exit 1")
        self.assertNotEqual(self.run_script("--start").returncode, 0)
        self.assertFalse(self.appdata.exists())

    def test_wrong_filesystem_refuses_start(self):
        self.mock("findmnt", "echo /")
        self.assertNotEqual(self.run_script("--start").returncode, 0)
        self.assertFalse(self.appdata.exists())

    def test_config_is_not_executed(self):
        sentinel = self.root / "executed"
        self.values["TZ"] = f"$(touch {sentinel})"
        self.assertNotEqual(self.run_script().returncode, 0)
        self.assertFalse(sentinel.exists())

    def test_duplicate_and_unknown_keys_fail(self):
        for extra in ("TZ=Etc/UTC\n", "HOST=private\n"):
            with self.subTest(extra=extra):
                self.assertNotEqual(self.run_script(extra=extra).returncode, 0)

    def test_missing_key_fails_even_if_inherited(self):
        del self.values["TZ"]
        self.env["TZ"] = "Etc/UTC"
        self.assertNotEqual(self.run_script().returncode, 0)

    def test_invalid_arguments_fail(self):
        for args in (("--unknown",), ("--start", "--unexpected")):
            with self.subTest(args=args):
                self.assertNotEqual(self.run_script(*args).returncode, 0)
        self.assertFalse(self.appdata.exists())

    def test_overlapping_data_directories_fail(self):
        for appdata in (self.media, self.media / "config", self.root):
            with self.subTest(appdata=appdata):
                self.values["APPDATA_DIR"] = str(appdata)
                self.assertNotEqual(self.run_script().returncode, 0)

    def test_symlinked_media_root_fails(self):
        alias = self.root / "alias"
        alias.symlink_to("/", target_is_directory=True)
        self.values["MEDIA_DIR"] = str(alias)
        result = self.run_script()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("cannot resolve to /", result.stderr)

    def test_path_resolution_failure_is_reported(self):
        self.mock("realpath", "exit 1")
        result = self.run_script()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Cannot resolve APPDATA_DIR", result.stderr)

    def test_missing_storage_directory_fails(self):
        self.mock("findmnt", "exit 1")
        self.assertNotEqual(self.run_script("--start").returncode, 0)
        self.assertFalse(self.appdata.exists())

    def test_docker_failure_does_not_create_directories(self):
        self.mock("docker", 'if [ "$1" = info ]; then exit 1; fi')
        self.assertNotEqual(self.run_script("--start").returncode, 0)
        self.assertFalse(self.appdata.exists())


if __name__ == "__main__":
    unittest.main()
