# Model validation — observed implementation results

Verified locally September 10, 2026 (UTC evidence timestamps September 11). This document describes executed checks, not phone or field accuracy.

## Artifacts and semantics

Official `yolo26n.pt` downloaded from the [Ultralytics v8.4.0 assets release](https://github.com/ultralytics/assets/releases/download/v8.4.0/yolo26n.pt), checkpoint SHA-256 `9b09cc8bf347f0fc8a5f7657480587f25db09b34bf33b0652110fb03a8ad4fef`. Preserved locally in ignored `training/weights/`.

| Profile | ONNX bytes | SHA-256 |
|---|---:|---|
| 416 | 9,796,924 | `703143276b5c7c32c18299510f490b3079e256fbd7866d891a1ef030a640ea21` |
| 320 | 9,767,944 | `3462385c62a59f028a400b71ecfa200c53880854f2e5078b73edb3c536d1ba02` |

Exporter: Ultralytics 8.4.146, PyTorch 2.14.0+cpu, ONNX 1.20.1, Python 3.13.12. Exact environment is `training/requirements.lock.txt`. Export options: fixed batch 1, side 416/320, FP32, dynamic=False, half=False, nms=False, simplify=False, opset=17, CPU. The installed exporter warns that half is deprecated in favor of quantize; half=False is still accepted and graph tensors are independently checked FP32. No unverified end2end argument is used. Source inspection `ultralytics/engine/exporter.py:682` confirms `model.end2end = self.args.nms is False`, matching [current upstream semantics](https://docs.ultralytics.com/guides/end2end-detection).

Both graphs have input `images` float32 `[1,3,S,S]`, output `output0` float32 `[1,300,6]`, processed one-to-one xyxy/score/class rows. No external NMS is applied to these e2e exports. Manifest records operators, export metadata, semantics, byte length, classes and runtime version. Pretrained mapping is COCO IDs 0,1,2,3,5,7. Unit coverage verifies custom sequential six-class mapping separately. Raw output decoder is tested but no raw/fallback checkpoint is claimed validated. YOLO11 fallback was unnecessary because primary export and browser inference succeeded.

## Real browser proof

`npm run test:model`: **11 passed**,6.7seconds in the final release run. This includes an independently built production Vite worker, public WASM MIME and ONNX byte checks. Four actual browser-model parity cases use the official repository sample bus photograph (portrait) and a gray-padded landscape derivative of that same photo. This is one source photograph, not a broad traffic evaluation dataset. PNG conversion avoids JPEG-decoder variation between reference and browser. Source URL/hash/license are in `tests/fixtures/provenance.json`.

`training/.venv/Scripts/python training/reference.py`: **4 PyTorch/ONNX parity cases passed**. Largest meaningful-row absolute delta: 0.0001068115234375. Reference uses an independent NumPy RGB pixel-center bilinear letterbox implementation. Padding RGB114, half-up resized dimensions and bottom/right extra padding are explicit. It does not assume OpenCV resize is pixel-identical.

The same real PNGs run through the application's actual dedicated worker, ONNX Runtime Web **1.29.0**, **single-thread WASM**, on desktop Chromium **153.0.8010.12**. Every expected semantic detection matches Python ONNX with box IoU >0.99 and score delta <0.001. Tests include corrupted model integrity, unknown format rejection, normalized coordinates, class-aware raw NMS, one active/one newest pending frame, profile reload and post-dispose rejection. `tests/model/browser-results.json` contains actual measured timings: final release run97.1–98.2ms for416 and71–78.6ms for320. A prior concurrent-work run took 291–330 ms / 223–227 ms, illustrating workload variation. These are variable single-image processing times including worker preprocessing, not sustained phone analysis rates.

Matching locked `.mjs`/`.wasm` assets total 13,986,063 bytes. `npm run assets:ort` copies them from installed ORT; `npm run model:verify` checks both model and runtime bytes/SHA-256. `npm run model:prepare` reuses packaged artifacts without Python; explicit `-- --export` rebuilds them. If artifacts are absent, preparation fails with an actionable message unless an authorized `MODEL_ASSET_BASE_URL` is configured; any download is verified against source-controlled SHA-256. Browser tests assert no page errors. Public asset normal HTTP caching is allowed; neither worker nor client writes application storage. App routes lazy-load camera mode; the viewer imports no detector client. The final E2E network/worker assertions verify no viewer model/runtime requests.

## Limits and unverified work

Physical-phone Safari/Android, cellular latency, sustained phone memory/Hz, real field speed accuracy, WebGPU, optional OCR, held-out mAP and custom training remain **NOT_RUN / DISABLED**. WASM is the only selectable provider. No GPU fallback claim is made. A single official sample establishes execution/preprocessing/decoding parity, not quality for distant cars or every target class. Camera tests must still measure the intended viewpoint.

Training preflight observed NVIDIA RTX 5070 Ti, 16,303 MiB total memory, driver 610.74. The isolated export environment uses CPU-only PyTorch, so CUDA forward pass and training were **NOT_RUN**. No driver/global Python modification or training run occurred. Optional safety suite: **21 passed** using explicitly synthetic temporary files for dataset, resume and promotion validation. No training ran.

## License and release boundary

Ultralytics publisher identifies weights/code under [AGPL-3.0 or a separately purchased license](https://www.ultralytics.com/license). Full notice is preserved in public models, and the upstream sample provenance is retained. ORT's MIT notice is from its matching v1.29.0 repository release. The release-hardening request authorizes AGPL-3.0 publication of the corresponding application source. Original private instruction/research packs are excluded; no paid license was purchased. Repository sample availability is not consent to use arbitrary road footage or identify people.

## Reproduction

```powershell
python -m venv training/.venv
training/.venv/Scripts/python -m pip install -r training/requirements.lock.txt
npm ci
npm run model:prepare -- --export
training/.venv/Scripts/python training/reference.py
npm run model:verify
npx playwright install chromium
npm run test:model
training/.venv/Scripts/python training/test_data.py
training/.venv/Scripts/python training/preflight.py
```

Initial bounded fixes: test-server working directory was made explicit; Playwright's required browser was installed; ORT npm tarball omitted LICENSE, so the matching upstream MIT notice was preserved separately. No failed assertion was removed. Early model tests isolated a blank harness while the application entry was still being implemented; they import the real detector client and worker, never fabricated inference output.
