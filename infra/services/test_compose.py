"""Validate the shared-service contract without starting any containers."""

import json
from pathlib import Path
import subprocess
import unittest


ROOT = Path(__file__).resolve().parent


class ComposeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.config = json.loads(subprocess.check_output(
            ["docker", "compose", "--env-file", ".env.example", "-f", "compose.yml",
             "--profile", "tunnel", "config", "--format", "json"],
            cwd=ROOT, text=True,
        ))
        cls.services = cls.config["services"]

    def test_services(self):
        self.assertEqual(set(self.services), {"hub", "redis", "gitea", "uptime", "cloudflared"})

    def test_images_are_immutable(self):
        for name, service in self.services.items():
            with self.subTest(service=name):
                self.assertRegex(service["image"], r"@sha256:[a-f0-9]{64}$")
                self.assertNotIn(":latest", service["image"])
                self.assertNotIn("container_name", service)
                self.assertEqual(service["restart"], "unless-stopped")

    def test_ports_are_private(self):
        for name, service in self.services.items():
            for port in service.get("ports", []):
                with self.subTest(service=name):
                    self.assertEqual(port["host_ip"], "127.0.0.1")
        self.assertNotIn("ports", self.services["redis"])

    def test_storage_does_not_create_missing_paths(self):
        for name, service in self.services.items():
            for volume in service.get("volumes", []):
                with self.subTest(service=name, target=volume["target"]):
                    self.assertEqual(volume["type"], "bind")
                    self.assertFalse(volume.get("bind", {}).get("create_host_path", False))
        configs = [v for v in self.services["hub"]["volumes"] if v["target"].startswith("/app/configuration/")]
        self.assertEqual(len(configs), 2)
        for config in configs:
            self.assertTrue(config["read_only"])
            self.assertTrue(Path(config["source"]).is_file())

    def test_hub_uses_embedded_storage_and_healthy_sessions(self):
        hub = self.services["hub"]
        self.assertEqual(hub["depends_on"]["redis"]["condition"], "service_healthy")
        self.assertEqual(hub["environment"]["APP_REDIS_URI"], "redis://redis:6379")
        self.assertIn('path: "/app/data/hub.db"', (ROOT / "hub.yaml").read_text())
        self.assertFalse(any(k.startswith("APP_DATABASE__HOST") for k in hub["environment"]))

    def test_tunnel_is_opt_in(self):
        self.assertEqual(self.services["cloudflared"]["profiles"], ["tunnel"])
        config = json.loads(subprocess.check_output(
            ["docker", "compose", "--env-file", ".env.example", "-f", "compose.yml", "config", "--format", "json"],
            cwd=ROOT, text=True,
        ))
        self.assertNotIn("cloudflared", config["services"])


if __name__ == "__main__":
    unittest.main()
