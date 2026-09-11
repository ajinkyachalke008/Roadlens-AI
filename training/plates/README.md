# Plate pipeline tooling

Four commands, in the order you would run them. Everything they download lands
in `training/data/plates/`, which Git ignores. No plate photograph and no plate
transcription is ever committed by these tools, and none should be added by hand.

```powershell
# 1. Build the licensed localization dataset (Open Images V7, ~8,100 images).
npm run plate:dataset

# 2. Fetch the US evaluation set with ground-truth plate text (OpenALPR, AGPL-3.0).
node scripts/worker-python.mjs training/plates/openalpr_us.py --region us

# 3. Train the single-class detector on the RTX GPU.
npm run plate:train -- --epochs 60 --max-minutes 75 --batch 32

# 4. Install the trained weights into the worker's hash-pinned model store.
node scripts/worker-python.mjs training/plates/prepare.py `
  --checkpoint training/runs/plates/plate-yolo26n/weights/best.pt `
  --metrics training/runs/plates/plate-yolo26n/roadlens-plate-summary.json
```

Then measure:

```powershell
npm run plate:ocr-bench                      # OCR engines, ground-truth crops
npm run plate:eval -- --suite us             # detector + end-to-end, US domain
npm run plate:eval -- --suite openimages     # localization mAP, global domain
npm run plate:eval -- --suite us --compare-preprocessing
```

Both downloads resume. The Open Images train annotation CSV is about 2.3 GB and
public mirrors do stall mid-stream, so `openimages.py` retries from the bytes it
already has rather than starting over; re-running the command is always safe.

## Splits and leakage

The dataset builder uses Open Images' own train/validation/test partition
verbatim and never reshuffles it. An image belongs to exactly one split
upstream, so no two frames of the same scene can straddle the evaluation
boundary. `train_plate.py` re-checks this before training and refuses to start if
any image id appears in two splits.

`IsGroupOf` and `IsDepiction` instances are discarded: a group box covers a
cluster of plates rather than one plate, and a depiction is a picture of a plate.
Training a localizer on either teaches it the wrong target.

## Evaluating on your own images

This is the evaluation that matters most, because it is the only one whose images
the models have certainly never seen. It needs no code changes.

1. Create `training/data/plates/user_eval/`.
2. Put your images in it. Use only images you are permitted to use — vehicles you
   own, vehicles whose owners consented, or footage you are otherwise entitled to
   evaluate. Do not scrape plate photographs.
3. Add `truth.csv` beside them:

```csv
image,x,y,width,height,text
lot-front-01.jpg,935,362,99,49,YG9X2G
lot-front-02.jpg,,,,,7ABC123
```

`x,y,width,height` are the plate box in source pixels and are optional. Supply
them to measure detection as well as reading; leave them empty to measure
end-to-end reading only. `text` is what you read with your own eyes.

4. Run it, naming the domain so the result file says what it describes:

```powershell
npm run plate:eval -- --suite user --domain "Consented parking-lot samples, California" `
  --output docs/evidence/plate-eval-user.json
```

The report gives exact-match accuracy, character accuracy, detector precision and
recall, and recall broken out by plate width in pixels.

## Using a different OCR engine

`fast-plate-ocr` is the measured default. `rapidocr` ships alongside it so the
comparison stays reproducible on any worker:

```powershell
npm run plate:eval -- --suite us --ocr rapidocr --preprocess clahe
```

Preprocessing is configurable rather than fixed because the right answer depends
on the engine — the recognizer that normalises internally is hurt by ours, and
the general-purpose one is helped. `--compare-preprocessing` is what decides it;
`docs/PLATE_VALIDATION.md` records the measurement behind the current default.
