# Optional local model work

The deployed app needs no Python, CUDA or development computer. Prepared public ONNX/WASM assets are already included. `npm run model:prepare` reuses and verifies packaged model files and copies the locked ORT assets without Python; `npm run model:verify` validates assets without exporting. If ONNX is missing, the command gives an explicit packaging/export error. Optional `MODEL_ASSET_BASE_URL` may point to an explicitly authorized HTTPS directory; downloads are verified against source-controlled hashes, never remote hashes. No model host URL is supplied or invented. Ultralytics artifacts carry AGPL-3.0 obligations; do not publish private code or silently relicense the project.

Create an isolated environment and install the exact tested dependencies:

```powershell
python -m venv training/.venv
training/.venv/Scripts/python -m pip install -r training/requirements.lock.txt
npm run model:prepare -- --export
training/.venv/Scripts/python training/reference.py
npm run test:model
```

On POSIX use `training/.venv/bin/python`; `ROADLENS_PYTHON` can explicitly select another isolated Python for the Node preparation script. `model:prepare -- --export` downloads only the 5.3 MB official nano checkpoint when absent and verifies its pinned hash before loading. It exports two fixed FP32 profiles and copies matching ORT assets. Re-exporting resets browser-validation flags; the browser suite writes its measured results to `tests/model/browser-results.json` without changing public manifests. Update a validation claim only after reviewing the matching hash and actual results. Browser model files and manifests are public deployment assets, not secrets. Never copy datasets/checkpoints into a deployed directory.

`preflight.py` reads GPU availability and tests a CUDA convolution only when CUDA is available. The installed export lock is CPU-only on this Windows environment; training requires a separately prepared compatible CUDA environment and its own verification. No global driver/environment changes are automated.

User-owned/consented dataset structure is `images/{train,val,test}`, `labels/{train,val,test}`, `traffic.yaml` (see `traffic.example.yaml`), and `sources.csv` with columns `image,source_group,split`. Image paths start with e.g. `images/train/frame001.png`. Assign complete source clips to exactly one split. Validator checks split isolation, labels/bounds, exact duplicate images, conservative dHash near-duplicates across splits, image readability and complete manifest coverage. dHash is heuristic and does not replace manual review.

```powershell
training/.venv/Scripts/python training/validate_data.py C:/approved/dataset --write-manifest
training/.venv/Scripts/python training/train.py --data C:/approved/dataset/traffic.yaml --max-minutes 20 --epochs 10
```

The train command is a dry run unless `--execute` is explicitly added after authorization for that dataset and resource bound. The YAML must omit `path` or set it to its absolute parent directory, use exactly the three displayed relative image directories, and have the six ordered classes. Download hooks and other split paths are rejected. Validation therefore covers the files the trainer actually selects.

Time is capped at 120 minutes, epochs at 30, batch at 8. An epoch callback retains the requested epoch cap even when Ultralytics time mode recalculates its own total. Trainer time checks are not a hard OS process-kill deadline and final validation may take additional time; plan accordingly. Resume is explicit `--resume .../last.pt` and must use a trusted local checkpoint whose dataset matches the validated YAML, whose configured epochs fit the requested maximum, and which still has unfinished optimizer state. Batch, workers, image size, device, patience and time are explicitly overridden. Checkpoint metadata is inspected only for an explicit execution; a dry run does not certify resume compatibility. Never claim completion or mAP from a dry run. No authorized training data was supplied and no training ran.

Export an authorized custom dual-head YOLO26 checkpoint into staging:

```powershell
training/.venv/Scripts/python training/export.py --checkpoint C:/approved/run/best.pt --output training/staging --model-id traffic-six-v1 --license AGPL-3.0 --source user-owned-consented-dataset
```

Class mapping comes from the actual checkpoint names. Export refuses missing semantic classes and custom outputs inside public assets. Staged custom graphs require real browser parity against their own reference and phone measurement before promotion.

Promotion tool (`promote.py`) defaults to dry run. It validates plain filenames/IDs, contained paths, exact preprocessing/runtime/input/e2e output semantics, artifact bytes/class mapping, and the preserved Ultralytics AGPL notice. Raw-head promotion is rejected because the current release build only verifies the inspected e2e head. It requires supplied matching successful browser **and physical-phone** evidence. `--accept-tradeoff` records the measured reason. `--execute` copies only model/manifest and preserves prior assets plus the tradeoff in a unique ignored `training/rollback` directory. Validation JSON fields are `modelSha256`, `browserParity: "PASS"`, `physicalPhoneBenchmark: "PASS"`, and nonempty `measurements`; they must reflect actual executed checks, not manually invented success. The tool cannot authenticate assertions in a hand-supplied JSON. A staged custom-model browser-reference runner is not implemented; custom promotion remains unused and requires independently executed matching checks. Do not promote untested custom weights. OCR remains disabled.

Safety regression command (synthetic temporary files; no training):

```powershell
training/.venv/Scripts/python -m unittest discover -s training -p "test_*.py" -v
```
