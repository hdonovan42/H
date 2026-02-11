"""YAML config loader — merges default.yaml with optional config.yaml overrides."""

import os
from pathlib import Path
import yaml


def _deep_merge(base: dict, override: dict) -> dict:
    """Recursively merge override into base."""
    merged = base.copy()
    for key, val in override.items():
        if key in merged and isinstance(merged[key], dict) and isinstance(val, dict):
            merged[key] = _deep_merge(merged[key], val)
        else:
            merged[key] = val
    return merged


def _find_project_root() -> Path:
    """Walk up from this file to find pyproject.toml."""
    p = Path(__file__).resolve().parent.parent
    while p != p.parent:
        if (p / "pyproject.toml").exists():
            return p
        p = p.parent
    return Path(__file__).resolve().parent.parent


_config_cache = None
_env_loaded = False


def _load_dotenv():
    """Load .env file from project root into os.environ."""
    global _env_loaded
    if _env_loaded:
        return
    _env_loaded = True
    env_path = _find_project_root() / ".env"
    if env_path.exists():
        with open(env_path) as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    key, _, value = line.partition("=")
                    os.environ.setdefault(key.strip(), value.strip())


def load_config(force_reload: bool = False) -> dict:
    """Load and merge config. Cached after first call."""
    global _config_cache
    if _config_cache is not None and not force_reload:
        return _config_cache

    _load_dotenv()
    root = _find_project_root()
    default_path = root / "config" / "default.yaml"
    override_path = root / "config.yaml"

    with open(default_path) as f:
        config = yaml.safe_load(f)

    if override_path.exists():
        with open(override_path) as f:
            overrides = yaml.safe_load(f) or {}
        config = _deep_merge(config, overrides)

    # Environment variable overrides
    if os.environ.get("VAULT_DB_FILE"):
        config["daemon"]["db_file"] = os.environ["VAULT_DB_FILE"]

    _config_cache = config
    return config


def get_db_path() -> Path:
    """Resolve DB file path (relative to project root)."""
    cfg = load_config()
    root = _find_project_root()
    return root / cfg["daemon"]["db_file"]


def get_pid_path() -> Path:
    """Resolve PID file path."""
    cfg = load_config()
    root = _find_project_root()
    return root / cfg["daemon"]["pid_file"]
