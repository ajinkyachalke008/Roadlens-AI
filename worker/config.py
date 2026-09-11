"""Environment-only configuration. Never include configuration values in errors."""
from dataclasses import dataclass, field
import os
import re
from urllib.parse import urlsplit


class ConfigurationError(ValueError):
    pass


@dataclass(frozen=True)
class Config:
    relay_url: str
    secret: str = field(repr=False)
    model_mode: str = "balanced"
    runtime: str = "pytorch_cuda"
    device: int = 0

    @classmethod
    def from_env(cls, env=None):
        env = os.environ if env is None else env
        url = env.get("ROADLENS_RELAY_URL", "")
        try:
            parsed = urlsplit(url)
            port = parsed.port
        except ValueError:
            raise ConfigurationError("ROADLENS_RELAY_URL is invalid") from None
        loopback = parsed.hostname in {"127.0.0.1", "localhost", "::1"}
        secure = parsed.scheme == "wss"
        development = parsed.scheme == "ws" and loopback and env.get("ROADLENS_ALLOW_LOOPBACK") == "true"
        if (not (secure or development) or not parsed.hostname or parsed.path != "/worker"
                or parsed.username is not None or parsed.password is not None or parsed.query or parsed.fragment
                or any(c.isspace() or ord(c) < 32 for c in url) or (port is not None and port == 0)):
            raise ConfigurationError("ROADLENS_RELAY_URL must be WSS with path /worker and no credentials or query")
        secret = env.get("ROADLENS_WORKER_SECRET", "")
        if not re.fullmatch(r"[A-Za-z0-9_-]{43}", secret):
            raise ConfigurationError("ROADLENS_WORKER_SECRET must be a 43-character base64url secret")
        if env.get("ALLOW_WORKER_CPU_FALLBACK", "false") != "false":
            raise ConfigurationError("Python CPU fallback is not supported; use browser fallback")
        mode = env.get("ROADLENS_MODEL_MODE", "balanced")
        runtime = env.get("ROADLENS_GPU_RUNTIME", "pytorch_cuda")
        if mode not in {"fast", "balanced", "quality"}:
            raise ConfigurationError("ROADLENS_MODEL_MODE must be fast, balanced, or quality")
        if runtime not in {"pytorch_cuda", "onnx_cuda", "tensorrt"}:
            raise ConfigurationError("ROADLENS_GPU_RUNTIME must select an NVIDIA runtime")
        device = env.get("ROADLENS_GPU_DEVICE", "0")
        if not re.fullmatch(r"\d{1,2}", device):
            raise ConfigurationError("ROADLENS_GPU_DEVICE must be a nonnegative device index")
        return cls(url, secret, mode, runtime, int(device))
