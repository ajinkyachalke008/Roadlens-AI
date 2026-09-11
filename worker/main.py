"""Foreground entry point: no listener, installation or model export on start."""
import asyncio
from concurrent.futures import ThreadPoolExecutor
from functools import partial
import json
import sys

from .config import Config, ConfigurationError
from .connection import WorkerConnection


def load_plate_reader(config):
    """Build the optional plate reader, or return None.

    Plate recognition is an enhancement, never a dependency. A missing model, a
    missing OCR package or a broken checkpoint downgrades this worker to traffic
    only and says so; it must not stop a working detector from serving.
    """
    if config.plate == "off":
        return None
    try:
        from worker.vision.plates import PlateDetector, PlateReader, load_ocr
        reader = PlateReader(PlateDetector(device=config.device),
                             load_ocr(config.plate_ocr, device=config.device),
                             preprocessing=config.plate_preprocess)
        reader.warmup()
        print("Plate recognition ready.", flush=True)
        return reader
    except Exception:
        # Third-party loaders can put paths into their errors; say only whether
        # the feature is available, and let the traffic pipeline continue.
        if config.plate == "on":
            raise RuntimeError("Plate recognition was required but could not be prepared")
        print("Plate recognition unavailable; traffic analysis continues.", flush=True)
        return None


async def run(config):
    from worker.vision.detector import Detector
    detector = None
    plate_reader = None
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
        plate_reader = await loop.run_in_executor(executor, partial(load_plate_reader, config))
        print("GPU warmup passed. Connecting to configured relay…", flush=True)
        connection = WorkerConnection(config, detector, emit=lambda line: print(line, flush=True),
                                      executor=executor, plate_reader=plate_reader)
        await connection.run()
    finally:
        if connection:
            await connection.request_stop()
            await connection.drain()
        if plate_reader:
            await loop.run_in_executor(executor, plate_reader.close)
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
