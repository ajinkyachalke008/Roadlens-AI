"""Foreground entry point: no listener, installation or model export on start."""
import asyncio
from concurrent.futures import ThreadPoolExecutor
from functools import partial
import json
import sys

from .config import Config, ConfigurationError
from .connection import WorkerConnection


async def run(config):
    from worker.vision.detector import Detector
    detector = None
    connection = None
    executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="roadlens-gpu")
    loop = asyncio.get_running_loop()
    try:
        print("RoadLens GPU Worker — verifying cached model and NVIDIA runtime.", flush=True)
        initialization = loop.run_in_executor(executor, partial(Detector, model_mode=config.model_mode, runtime=config.runtime, device=config.device))
        try:
            detector = await asyncio.shield(initialization)
        except asyncio.CancelledError:
            detector = await asyncio.shield(initialization)
            raise
        warmup = loop.run_in_executor(executor, partial(detector.warmup, iterations=5))
        try:
            await asyncio.shield(warmup)
        except asyncio.CancelledError:
            await asyncio.shield(warmup)
            raise
        health = await loop.run_in_executor(executor, detector.health)
        if not health.get("ready"):
            raise RuntimeError("GPU warmup did not establish readiness")
        safe = {key: health[key] for key in ("ready", "runtime", "modelId", "modelSha256", "inputSize", "gpu", "device", "vramAllocatedMiB") if key in health}
        print(json.dumps(safe, allow_nan=False), flush=True)
        print("GPU warmup passed. Connecting to configured relay…", flush=True)
        connection = WorkerConnection(config, detector, emit=lambda line: print(line, flush=True), executor=executor)
        await connection.run()
    finally:
        if connection:
            await connection.request_stop()
            await connection.drain()
        if detector:
            await loop.run_in_executor(executor, detector.close)
        executor.shutdown(wait=True)


def main():
    try:
        config = Config.from_env()
        asyncio.run(run(config))
        return 0
    except KeyboardInterrupt:
        print("GPU worker stopped; browser fallback remains available.", flush=True)
        return 0
    except ConfigurationError as error:
        print(f"GPU WORKER NOT READY: {error}", file=sys.stderr, flush=True)
        return 2
    except (ImportError, ModuleNotFoundError):
        print("GPU WORKER NOT READY: missing worker packages. Run .\\setup-worker.ps1.", file=sys.stderr, flush=True)
        return 3
    except Exception:
        # Third-party errors may contain paths or frame content. Detailed GPU
        # preflight is an explicit separate CLI; never dump a network payload.
        print("GPU WORKER NOT READY: CUDA/model initialization failed. Run the GPU preflight and setup self-test.", file=sys.stderr, flush=True)
        return 4


if __name__ == "__main__":
    raise SystemExit(main())
