# Plate recognition: measured results and status

Everything below was produced by the commands in
[PLATE_VALIDATION.md](PLATE_VALIDATION.md) on this project's own hardware. The
two validations are kept apart on purpose: public-dataset numbers say what the
models do on licensed public data, and they are not a substitute for pointing a
real camera at a real vehicle.

Machine: Windows 11, NVIDIA GeForce RTX 5070 Ti (16 GB), driver 610.74, CUDA
13.0, PyTorch 2.14.0+cu130, ONNX Runtime 1.29.0, Ultralytics 8.4.146,
Python 3.13.12. Measured 2026-09-11.

## Status

| | |
| --- | --- |
| Plate feature status | **EXPERIMENTAL** |
| Public-dataset validation | **PASS** — localization and US end-to-end, both reproducible |
| Physical RoadLens validation | **NOT VERIFIED** |

`EXPERIMENTAL`, not `READY`, and the reason is specific rather than cautious:
no measurement here involved a phone camera pointed at a real vehicle, and the
OCR model's training corpus is unpublished, so contamination of the headline US
figure by this public benchmark cannot be excluded. The pipeline is complete,
bounded and tested; the domain evidence has a named hole in it.

## Plate detector

| | |
| --- | --- |
| Model | `plate-yolo26n-640-v1`, SHA-256 `455dd221ac63…` |
| Architecture | YOLO26n, single class `license_plate`, 640 px, 2.38 M parameters, 5.4 MB |
| Base weights | Ultralytics YOLO26n, AGPL-3.0, hash verified before training |
| Licence | AGPL-3.0 |
| Training data | Open Images V7 `Vehicle registration plate`, 5,365 images / 7,846 boxes |
| Epochs | Early-stopped at 60; best at epoch 45; 27 minutes wall clock |

The shipped checkpoint is the one the **validation** split chose, not the one
that happened to score best on the US test set. An earlier checkpoint scored
marginally higher end-to-end on the US benchmark (87.8 % vs 86.5 %, a difference
of three plates out of 222); selecting on that basis would have quietly turned
the held-out set into a validation set and destroyed the only independent US
number this project has.

### Localization

| split | images | plates | precision | recall | mAP50 | mAP50-95 |
| --- | --- | --- | --- | --- | --- | --- |
| Open Images validation | 721 | 982 | 0.930 | 0.832 | 0.887 | 0.623 |
| **Open Images test (held out)** | **2,054** | **2,824** | **0.936** | **0.819** | **0.877** | **0.612** |
| OpenALPR US (IoU ≥ 0.5, conf 0.25) | 222 | 222 | 0.921 | **0.991** | — | — |

Inference is 1.4 ms per image at 640 px.

### Small-plate behaviour

Recall by plate width in source pixels, on the US benchmark:

| plate width | plates | recall |
| --- | --- | --- |
| 0–24 px | 0 | — |
| 24–48 px | 0 | — |
| 48–96 px | 142 | 0.986 |
| 96 px+ | 80 | 1.000 |

**Every plate in this benchmark is at least 48 px wide, so it says nothing at
all about small plates** — which is exactly the regime that decides whether the
pipeline is useful at the roadside. This is the single biggest gap in the public
evidence, and it is the main reason the shipped architecture sends a
full-resolution vehicle crop rather than relying on the analysis frame: the
design assumes small plates even though this benchmark cannot show them.

## OCR engine selection

Measured on 222 ground-truth plate crops from the OpenALPR US benchmark, CUDA,
RTX 5070 Ti. Crops come from the annotated boxes, so this isolates recognition
from localization.

| engine | preprocessing | exact | character | coverage | mean ms |
| --- | --- | --- | --- | --- | --- |
| fast-plate-ocr | **none** | **88.7 %** | **97.96 %** | 100 % | 4.5 |
| fast-plate-ocr | gray | 88.3 % | 97.93 % | 100 % | 4.8 |
| fast-plate-ocr | rectify | 87.4 % | 97.13 % | 100 % | 5.0 |
| fast-plate-ocr | clahe | 86.9 % | 97.06 % | 100 % | 4.1 |
| fast-plate-ocr | sharpen | 82.4 % | 96.02 % | 100 % | 4.2 |
| rapidocr | clahe | 59.5 % | 79.15 % | 92.8 % | 109.9 |
| rapidocr | rectify | 57.7 % | 78.13 % | 92.3 % | 112.2 |
| rapidocr | gray | 55.9 % | 74.51 % | 86.0 % | 104.1 |
| rapidocr | sharpen | 54.1 % | 78.33 % | 95.5 % | 109.3 |
| rapidocr | none | 53.6 % | 74.58 % | 87.8 % | 105.0 |

**Selected: `fast-plate-ocr` 1.1.0 (MIT), `cct-s-v2-global-model`, no
preprocessing.** 29.2 points more accurate and roughly 23× faster than the
alternative on identical crops.

The preprocessing result is the useful part of this table and it is not what one
would guess. Every transformation we add *hurts* the chosen engine — it
normalises internally, so CLAHE and unsharp masking destroy information it was
trained on. The same transformations *help* the general-purpose engine
(53.6 % → 59.5 %). That is why preprocessing stayed configurable instead of
fixed, and why the default is `none`.

No super-resolution is used anywhere. Upscaling in `preprocess_crop` is plain
interpolation to the recogniser's working height; it adds no detail, because the
detail was never sampled.

### Candidates not measured

| engine | why not |
| --- | --- |
| PaddleOCR / PP-OCR (native) | `paddlepaddle-gpu` on Windows supports at most CUDA 12.9, while this worker runs CUDA 13.0 with PyTorch cu130. Installing a second, conflicting CUDA runtime into the verified worker environment was a worse trade than the possible gain — and PP-OCR's recognition models *were* measured, through RapidOCR's ONNX export of them. |
| EasyOCR | A general-purpose CRNN with the same weakness RapidOCR showed: it reads every string in the crop and must then be told which is the plate. With the selected engine at 88.7 % and 4.5 ms, adding scipy and scikit-image to a verified worker environment for a likely-worse candidate was not justified. Recorded as **not measured**, not as rejected on evidence. |

## End-to-end, US domain

Full pipeline over whole photographs: our detector picks its own plate, then
reads it. 222 images, OpenALPR US benchmark.

| | |
| --- | --- |
| Detector precision (IoU ≥ 0.5) | 0.921 |
| Detector recall (IoU ≥ 0.5) | 0.991 |
| **Exact plate string** | **86.5 %** |
| **Character accuracy** | **95.3 %** |
| Coverage (produced any reading) | 99.1 % |
| Latency median / mean / p95 | 14.1 / 14.9 / 17.1 ms |

Localization costs about 2.2 points against the 88.7 % ceiling the same OCR
reaches from ground-truth boxes, so recognition — not detection — is the
binding constraint.

**These are single-frame numbers.** The shipped pipeline requires agreement
across at least two frames before it reports anything, so the deployed
false-reading rate should be lower and the no-reading rate higher than this
table. Single frames are all the public benchmark contains.

## Impact on traffic analysis

`npm run plate:benchmark` — YOLO26s at 640 on the permitted project photograph,
same process, same GPU, 60 frames per condition.

| condition | analysis Hz | total ms (median) | GPU inference ms | Δ vs baseline |
| --- | --- | --- | --- | --- |
| baseline — no plate support | 71.91 | 13.91 | 7.34 | reference |
| loaded — plate models resident, never invoked | 71.18 | 14.05 | 7.39 | −1.0 % |
| interleaved — a plate read every 4th frame | 71.23 | 14.04 | 7.45 | −0.9 % |

Across three repeat runs the deltas spanned **−1.6 % to +2.7 %**, straddling zero
in both directions. That spread is run-to-run variation, not a cost and
certainly not a speed-up: **plate support makes no measurable difference to
traffic analysis throughput.** The traffic benchmark is also unchanged —
YOLO26s still measures 7.75 ms inference / 14.11 ms total, as before this work.

| plate read | value |
| --- | --- |
| median total | 13.05 ms (8.58 detect + 3.34 OCR) |
| p95 total | 39.13 ms |

The `interleaved` row is deliberately pessimistic: it reads a plate every fourth
frame, where the shipped bounds allow at most four reads for an entire track.
Even so it is indistinguishable from baseline, because a 13 ms read only ever
runs in a gap where no analysis frame is waiting.

## Multi-frame consensus

| | |
| --- | --- |
| Implemented | Weighted voting with confusable-glyph grouping and per-position resolution |
| Minimum supporting frames | 2 |
| Minimum confidence | 0.55 |
| Behaviour below either floor | `plateText = null`, UI shows "Unreadable" |
| Tests | `tests/unit/plates.test.ts` — agreement, ambiguous-position resolution, never inventing characters, lone-frame rejection, weak-agreement rejection, blank readings counted against |

## Privacy

| check | result |
| --- | --- |
| Worker retains no crop, reading or history between requests | PASS — `worker/tests/test_plate_connection.py` |
| Phone state is RAM-only and epoch-scoped | PASS — `tests/unit/plates.test.ts` reset test |
| No plate database, archive, telemetry or local storage | PASS — `scripts/check-no-persistence.mjs` |
| No plate strings, images, dataset credentials or secrets committed | PASS — `scripts/check-plate-privacy.mjs` |
| No plate text on the live overlay | PASS — by design; plates appear only in report cards |
| End session clears plate state | PASS — same teardown as reports and calibration |

## Test coverage

| suite | before | after |
| --- | --- | --- |
| Unit | 189 | 223 |
| Contracts | 49 | 85 |
| Integration | 62 | 80 |
| Worker (pytest) | 40 + 68 subtests | 90 + 135 subtests |
| E2E / privacy / model | 12 / 10 / 11 | unchanged, all passing |

## Physical RoadLens validation

**NOT VERIFIED.** No measurement in this file involved a phone camera pointed at
a real vehicle. The procedure is in
[PLATE_VALIDATION.md](PLATE_VALIDATION.md#physical-test-mode); it is deliberately
safe to run from a car park and needs no speeding vehicle.

Until an operator completes it and records the result here, the plate feature
stays `EXPERIMENTAL` regardless of how good the public-dataset numbers look.
