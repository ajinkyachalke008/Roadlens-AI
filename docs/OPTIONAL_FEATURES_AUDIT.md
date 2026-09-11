# Release-hardening model and optional-feature audit

Source/artifact audit followed by authorized bounded inference/training fixes for the release-hardening request. No model was replaced, no OCR dependency/weight/data was downloaded, and no training started. Initial findings below describe the inspected pre-fix state; the disposition and freshly executed checks follow them. Public deployment, physical-phone performance and real field speed remain unverified.

> **Superseded for plate recognition, 2026-09-11.** The decision recorded below
> was correct for the evidence available at the time, and it named the exact
> conditions an implementation would have to meet: a real localized plate, actual
> OCR, multiple agreeing readings, null on ambiguity, candidate-only retention,
> bounded crops and jobs, release-on-end, and measured coexistence with the
> traffic detector. Those conditions are now met and measured. The reasoning here
> is kept as the record of why the feature waited; the current design,
> measurements and remaining limits are in
> [PLATE_VALIDATION.md](PLATE_VALIDATION.md), [PLATE_DATASETS.md](PLATE_DATASETS.md)
> and [PLATE_RESULTS.md](PLATE_RESULTS.md).
>
> Two judgements below were revised by measurement rather than by opinion. The
> phone-compute objection was correct and is why plate work runs entirely on the
> GPU worker and never on the phone. The "≤640-pixel sampled image" objection was
> also correct, and is why a plate request carries a crop of one vehicle taken
> from the phone's full-resolution canvas rather than anything from the analysis
> stream.

## Release decision: keep plate recognition disabled

**Plate recognition — experimental / future extension.** The current application has no plate detector, OCR worker, language assets, plate decoder, plate confidence/consensus module, consented labeled plate fixtures, or measured phone OCR budget. The public model directory contains exactly two YOLO26n traffic ONNX files and their manifests/license. `package.json` and `package-lock.json` contain no Tesseract/plate OCR package. Shared reports contain no plate result fields. No text is being guessed or exported as a plate.

The working traffic detector must remain. Its six semantic classes are person, bicycle, car, motorcycle, bus and truck; a license plate is not one of its mapped classes. Existing original-resolution completed canvases could support a later crop pipeline, but the current retained report JPEG is a ≤640-pixel sampled image, and adding OCR to those thumbnails would not establish reliable plate quality.

This decision is based on actual missing artifacts and tests, not a claim that browser OCR is impossible:

| Candidate | Primary-source finding | RoadLens readiness |
|---|---|---|
| Tesseract.js | Publisher supports browser workers, reuse and termination. Apache-2.0 repository. Generic OCR; it does not improve the underlying Tesseract recognition model. [Repository](https://github.com/naptha/tesseract.js) | Not installed or tested here; no plate localization model or readable labeled plate set |
| Self-hosted Tesseract assets | Worker, language and core paths are separately configurable. Default traineddata cache writes IndexedDB; `cacheMethod: 'none'` avoids reads/writes. [API](https://github.com/naptha/tesseract.js/blob/master/docs/api.md), [local assets](https://github.com/naptha/tesseract.js/blob/master/docs/local-installation.md) | A default installation would violate the project's durable browser-storage prohibition; matching audited assets and runtime privacy tests would be required |
| Open Image Models plate detector | Maintainer supplies ONNX plate detector families including `yolo-v9-t-256-license-plate-end2end`; Python examples and reported model evaluations are available. The wrapper repository is MIT. [Publisher repository](https://github.com/ankandrew/open-image-models) | No artifact downloaded, hashed, license/data-provenance cleared or inspected in this project. No browser-operator parity or phone runtime evidence |
| Fast Plate OCR | Maintainer's OCR expects already-cropped plates and offers ONNX models/configuration. Published speed table uses RTX3090 with TensorRT/CUDA/CPU providers. MIT repository. [Publisher repository](https://github.com/ankandrew/fast-plate-ocr) | Server/GPU timings are not phone-WASM timings. No concrete weight/license/dataset review, decoder, consensus or RoadLens browser test exists |

Repository license labels alone are not a determination that every linked model/dataset is suitable for this release. No additional license permission or corresponding-source approval is inferred. Local Ultralytics artifacts retain their existing AGPL notices and the root release decision remains integrator-owned.

Current recorded desktop traffic inference costs 104.5–105.0ms (416) and 75.0–79.4ms (320), including preprocessing, in `tests/model/browser-results.json`; these are release-hardening samples at 2026-09-11T01:47:04Z. The qualified-speed gate needs ≥4Hz actual observations with ≤350ms gaps. There is no spare-phone-compute measurement establishing that a second detector plus OCR can fit alongside those gates. Therefore there is no evidence-based basis to expose OCR in the release UI. Any future implementation needs consented crops, a real localized plate, actual OCR, multiple agreeing readings, null on ambiguity, candidate-only retention, bounded crops/jobs, lazy loading, release-on-end, and measured coexistence with the traffic detector.

## Preserved model/provenance facts

Read-only SHA-256 hashing during this audit matched the current binaries:

| Profile | Bytes | SHA-256 |
|---|---:|---|
| YOLO26n 416 FP32 | 9,796,924 | `703143276b5c7c32c18299510f490b3079e256fbd7866d891a1ef030a640ea21` |
| YOLO26n 320 FP32 | 9,767,944 | `3462385c62a59f028a400b71ecfa200c53880854f2e5078b73edb3c536d1ba02` |

Both manifest contracts remain `images` float32 `[1,3,S,S]` → `output0` float32 `[1,300,6]`, explicit one-to-one xyxy/score/class decoder. Export metadata records Ultralytics8.4.146, Torch2.14.0+cpu, ONNX1.20.1, fixed FP32/opset17/nms=False; package lock supplies ONNX Runtime Web1.29.0. Exactly matching public WASM/MJS assets total13,986,063B. Single-thread WASM remains the only selectable provider; no WebGPU or YOLO11 execution claim is needed. Prior actual Python/browser parity is in `MODEL_VALIDATION.md`; the integrator is rerunning the release baseline separately.

## Concrete hardening findings

These findings are code-confirmed; they were sent to the integrator before edits. They do not invalidate the existing successful model outputs.

1. **Core: stalled model operations have no deadline.** `frontend/src/inference/worker.ts` uses unbounded manifest/model fetch, session creation and `session.run`; `client.ts` waits indefinitely for worker messages. A stalled response/session can leave camera resources and Loading/busy state alive until user end/pause. Add bounded deadlines with visible error and worker termination, preserving the known model and single-job invariant. A watchdog is needed around synchronous/blocked WASM because a worker-local timer alone cannot interrupt blocked execution.

2. **Core promotion compatibility: unsupported preprocessing metadata is accepted.** `validateManifest` checks input tensor/color/layout and output tag but does not check the manifest's `letterbox` policy or `decoderVersion`; the worker always uses local fixed preprocessing/decoding. A read-only pure-function reproduction changed decoderVersion to `unimplemented-v99` and letterbox to black padding/nearest/top-left; the validator still accepted it. Fail unknown policy/version before model execution, and add manifest-policy tests. This guards future promotion without changing current numerics.

3. **Core edge case: extreme aspect ratios produce zero resize dimensions.** Read-only `letterbox(1,10000,416)` returned resizedWidth0/scaleX0. Reject or explicitly handle dimensions that round to zero before normalization; do not emit NaN/infinite inverse coordinates.

4. **Requested adaptation is missing.** `CameraCapture` uses a fixed190ms source-time scheduling threshold and manually selected profile; there is no measured automatic416→320 downgrade. Current one-job behavior is bounded, and speeds correctly remain null when slow. This is a missing requested graceful-degradation feature, not justification to replace YOLO or relax measurement gates. Integrator owns capture changes.

5. **Training: validation can examine different data from the trainer.** `training/train.py` validates `args.data.parent` but passes the YAML unchanged to Ultralytics. YAML `path`, `train`, `val`, `test` may point elsewhere, so valid directoryA can authorize a run on unvalidated directoryB. Resolve and validate the actual YAML paths, or reject any layout outside the validated fixed tree. No training run was launched to reproduce this static path mismatch.

6. **Training resume: configured bounds/data are not enforced.** The resume branch invokes `.train(resume=True,time=...)`, omitting validated dataset and batch/epoch controls. Installed `ultralytics/engine/trainer.py::check_resume` restores checkpoint arguments; batch may be overridden but epochs/data are not among normal resume overrides. A checkpoint can therefore restore a larger batch/epoch count or different dataset despite the CLI checks. Inspect and constrain checkpoint run metadata before resume, document the actual supported boundary, and test without launching training.

7. **Promotion: manifest fields become unrestricted paths.** `training/promote.py` joins unvalidated `m['file']` into both source/public destinations and `m['id']` into rollback destination. `../` or absolute manifest values can escape intended directories under `--execute`. Validate filename/identifier syntax, resolved path containment and symlinks before any copy. Also preserve license notices and validate complete manifest/runtime compatibility. This is local explicitly invoked tooling; no remote application attack path is claimed.

8. **Custom promotion remains partial.** The promotion script accepts both raw/e2e formats but `scripts/verify-model.mjs` only accepts e2e `[1,300,6]`; reference/browser fixtures are fixed to the original pretrained model. A custom raw promotion can succeed and then fail the production build. Validation evidence is supplied JSON rather than generated through a staged custom-model test command. Keep custom promotion labeled partial/unused until these paths are aligned; pretrained release remains functional.

## Fix disposition and fresh execution

Findings 1–3 are fixed: a main-thread watchdog caps loading at 90 seconds and inference at 15 seconds, terminates stalled workers, rejects active/latest pending work, closes frame handles and permits a fresh load. Tests inject smaller constructor limits. Unknown decoder/preprocessing policies, wrong manifest profile, incompatible tensor axes/threshold ordering and aspect ratios rounding to zero fail visibly. Existing model numerics and model/runtime assets are unchanged. Browser tests now write evidence results without mutating public manifests.

Findings 5–7 are fixed: training validates the actual YAML-selected fixed local tree and rejects download hooks, foreign split/root paths and escaping labels. Image coverage includes the installed exporter's supported extensions. Resume checks dataset/epoch/optimizer metadata, explicitly reapplies allowed batch/time/device bounds, and adds an epoch-stop callback because Ultralytics time mode recalculates epochs. Promotion rejects unsafe source/destination/rollback names and escaping paths, incompatible runtime/preprocessing/head semantics, missing preserved license/provenance, and collisions with another artifact. Each promotion keeps a unique rollback directory and measured tradeoff.

Finding 8 is constrained: raw-head promotion is now explicitly rejected rather than producing a later build failure. A custom staged-model reference/browser runner remains unimplemented, and externally supplied JSON evidence is not independently authenticated by the promotion script. No custom model was promoted. Finding 4 belongs to the integrator's camera adaptation changes; this audit does not claim its tests.

Executed after these edits:

| Command | Observed result |
|---|---|
| `npx vitest run tests/unit/inference-release.test.ts` | 8 passed: fake-worker timeout/resource/restart tests and pure manifest/aspect tests; these are not browser inference proof |
| `training/.venv/Scripts/python -m unittest discover -s training -p "test_*.py" -v` | 21 passed (6 dataset checks, 15 YAML/resume/promotion safety checks); temporary synthetic fixtures, no GPU/training |
| `npx tsc --noEmit` | Passed |
| `npx eslint frontend/src/inference tests/unit/inference-release.test.ts tests/model/browser.spec.ts` | Passed |
| `npm run test:model` | 11 passed, sequential run authorized by integrator. Real Chromium worker/production bundle WASM inference, 416/320 portrait/landscape parity, corrupted hash rejection, bounded jobs/disposal, explicit decoders |

The real-photo parity remains one original permitted photo plus a padded landscape version, not a phone dataset or field evaluation. Actual detection counts were 6/5 (416 portrait/landscape) and 5/6 (320). Expected-box IoU exceeded 0.99 and score delta stayed below 0.001. No physical-phone, field-speed, OCR or training result is inferred.

## Scope of evidence and next ownership

The initial audit ran file reads, package/source searches, current primary-source research, read-only model hashing and a pure-function metadata/letterbox reproduction. Authorized fixes and their fresh checks are listed above. It did not alter weights, install OCR, use a paid API, modify dependencies or run training. There is no `graphify-out/graph.json`; the requested read-only audit did not create a knowledge graph or install another tool. Root owns baseline execution, code-fix assignment, shared contracts, package locks, release/source licensing, Git and deployment. All optional-feature availability and latency claims above remain bounded to the cited evidence.

## Optional GPU worker reevaluation — 2026-09-10

Plate recognition remains disabled. The subsequently authorized outbound GPU worker makes local CUDA OCR an option to evaluate; it does not supply a plate evaluation dataset or prove recognition. This assessment read current primary sources and existing worker pins only. No OCR package, weight, dataset or training job was installed or run, and no app feature was enabled. The permitted bus photograph is not a consented, labeled, readable-plate evaluation set.

| Candidate | Observed primary evidence | Release consequence |
|---|---|---|
| Open Image Models plate detector | The [maintainer README](https://github.com/ankandrew/open-image-models) publishes YOLOv9 tiny ONNX variants from 256 to 640 pixels and a 608 small model; its [software license](https://github.com/ankandrew/open-image-models/blob/main/LICENSE) is MIT. The [older LocalizadorPatentes source](https://github.com/ankandrew/LocalizadorPatentes) names OpenImages, Romanian and OpenALPR data and explicitly says its older model did not train on Argentine plates. | A practical small-model candidate. Do not transfer the older model's dataset list to the current YOLOv9 weights: the exact newer training mixture, geographic coverage and weight provenance still need verification. A wrapper license alone is insufficient provenance for a promoted weight. |
| Morsetechlab YOLO11 plate detector | The [author model card](https://huggingface.co/morsetechlab/yolov11-license-plate-detection) declares AGPL-3.0 and offers nano through extra-large PyTorch/ONNX variants. It links a 10,125-image [Roboflow dataset version labeled CC BY 4.0](https://universe.roboflow.com/roboflow-universe-projects/license-plate-recognition-rxg4e/dataset/11). | More explicit model/data attribution, but the author discloses train/test contamination and warns that published metrics overestimate generalization. It provides no dependable target-country coverage breakdown and cautions about motorcycles, non-Latin scripts and small plates. It is an evaluation candidate, not a validated release model. |
| EasyOCR | The [maintainer installation instructions](https://github.com/JaidedAI/EasyOCR/blob/master/README.md) require Windows users to preinstall suitable CUDA PyTorch/torchvision. Its [license](https://github.com/JaidedAI/EasyOCR/blob/master/LICENSE) is Apache-2.0; [requirements](https://github.com/JaidedAI/EasyOCR/blob/master/requirements.txt) do not pin the project's exact PyTorch/Python combination. | Plausible first isolated experiment using the existing worker's PyTorch CUDA stack. Windows Python 3.13 with the project's torch 2.14.0+cu130/torchvision 0.29.0+cu130 is **not tested for EasyOCR here**; generic Windows support is not that proof. |
| PaddleOCR / PaddlePaddle | The [PaddleOCR installation page](https://www.paddleocr.ai/latest/en/version3.x/installation.html) separates the OCR package from its inference engine. The [official CUDA 13 wheel index](https://www.paddlepaddle.org.cn/packages/stable/cu130/paddlepaddle-gpu/) contains `paddlepaddle_gpu-3.3.0-cp313-cp313-win_amd64.whl` and `3.3.1` for the same platform. The [Windows guide](https://www.paddlepaddle.org.cn/documentation/docs/en/install/pip/windows-pip_en.html) permits Python 3.13 but still shows older CUDA 11.8/12.6/12.9 examples. | Windows/Python 3.13/CUDA 13 package availability is established; declaring this combination unsupported would be incorrect. PaddleOCR dependency resolution, native operators, actual CUDA execution on this RTX 5070 Ti, and coexistence with the traffic model remain untested. No wheel was downloaded. |

EasyOCR's [actual Reader source](https://github.com/JaidedAI/EasyOCR/blob/master/easyocr/easyocr.py) falls back to CPU when `gpu=True` and CUDA/MPS are unavailable; it also downloads missing model weights by default. Any future worker integration must explicitly require CUDA, fail visibly on a device mismatch, prepare pinned and hashed weights beforehand, and disable runtime downloads. Plate crops/results must remain bounded RAM data with the existing cancellation and session cleanup rules. Public weight caching is distinct from writing captured plate images or recognized text.

The next useful data action is to authorize a small, controlled set of parked-vehicle clips from the intended country/plate format, with recording permission, plate boxes, exact readable strings and explicit unreadable/occluded negatives. Keep multiple observations of one vehicle together in the same evaluation group. Establish whether the actual transmitted 640/960-edge JPEG retains enough character detail before selecting OCR. A bounded experiment can then compare exact-string accuracy, false accepted strings, abstention on ambiguity, multi-frame agreement, memory and traffic-analysis latency on the real worker. Until those tests succeed, return unknown plate text and preserve the disabled UI. No OCR accuracy, latency, geographic reliability or field readiness is claimed by this assessment.
