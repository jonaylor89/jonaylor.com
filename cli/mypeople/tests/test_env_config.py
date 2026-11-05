"""Credential discovery must not depend on the checkout or working directory."""
import os
from pathlib import Path

from mypeople import llm


def test_default_env_is_private_home_file(tmp_path, monkeypatch):
    monkeypatch.delenv("MYPEOPLE_ENV_FILE", raising=False)
    monkeypatch.setenv("MYPEOPLE_CONFIG_TEST", "")
    monkeypatch.delenv("MYPEOPLE_CONFIG_TEST")
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: tmp_path))
    private = tmp_path / ".mypeople"
    private.mkdir()
    (private / "secrets.ini").write_text("MYPEOPLE_CONFIG_TEST=private\n")
    checkout = tmp_path / "checkout"
    checkout.mkdir()
    (checkout / ".env").write_text("MYPEOPLE_CONFIG_TEST=checkout\n")
    monkeypatch.chdir(checkout)
    llm.load_env_file()
    assert os.environ["MYPEOPLE_CONFIG_TEST"] == "private"


def test_explicit_env_file_and_environment_precedence(tmp_path, monkeypatch):
    private = tmp_path / "config.env"
    private.write_text("MYPEOPLE_CONFIG_TEST=file\n")
    monkeypatch.setenv("MYPEOPLE_ENV_FILE", str(private))
    monkeypatch.setenv("MYPEOPLE_CONFIG_TEST", "environment")
    llm.load_env_file()
    assert os.environ["MYPEOPLE_CONFIG_TEST"] == "environment"
    monkeypatch.delenv("MYPEOPLE_CONFIG_TEST")
    llm.load_env_file()
    assert os.environ["MYPEOPLE_CONFIG_TEST"] == "file"
