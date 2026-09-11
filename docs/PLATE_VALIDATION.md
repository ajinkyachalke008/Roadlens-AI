# Plate recognition: architecture, measurements and limits

RoadLens reads a licence plate only for a vehicle that something has already
qualified — an operator selection, or a speed candidate the rules produced. It
reads a small bounded number of frames, agrees across them, and reports a plate
only when that agreement is strong enough to defend. When it is not, the answer
is "Unreadable", and that is a correct answer.

Two validations are reported here and they are never mixed:

- **Public-dataset validation** — measured, reproducible, on licensed public data.
- **Physical RoadLens validation** — a real camera pointed at real vehicles.

Status and the exact figures live in [PLATE_RESULTS.md](PLATE_RESULTS.md).
Dataset and model provenance lives in [PLATE_DATASETS.md](PLATE_DATASETS.md).

## Pipeline

```
traffic frame (full resolution, on the phone)
  → YOLO26s vehicle detector (GPU worker)
  → tracked vehicle id
  → trigger: operator request, or speed candidate
  → crop the vehicle from the FULL RESOLUTION source frame
  → quality score: pixels, sharpness, framing, pose
  → bounded best-frame buffer, at most 4 crops per track
  → RLP1 request to the GPU worker (at most one in flight, anywhere)
  → single-class plate detector → plate crop → OCR
  → single-frame reading returned; the worker keeps nothing
  → multi-frame consensus on the phone
  → report field, or "Unreadable"
```

### Why the crop comes from the full resolution frame

The analysis stream sends a 640 px long-edge JPEG of the whole scene. A plate in
that image is often a dozen pixels wide, and no amount of processing recovers
detail that was never sampled. A plate request instead carries a crop of one
vehicle taken from the phone's full resolution canvas, scaled to at most 640 px
on its long edge. The same 640 px budget then describes one car instead of the
whole road, which is the entire reason the pipeline can read anything at all.

### Why consensus lives on the phone

The worker returns one reading for one crop and forgets it: no crop, no text, no
track, no history. The phone already owns track state and already clears it at
End session, so putting agreement there means plate identity has exactly one
home and exactly one lifetime.

## Why the traffic detector was not changed

YOLO26s at 640 remains the traffic detector, unchanged, and nothing in this work
argued for replacing it.

Plate difficulty is a small-object problem, and the fix for a small object is to
look at it closely rather than to enlarge the model that looks at everything.
Growing to YOLO26m would raise the cost of the model that runs on *every* frame
in order to serve work that runs on a handful of frames per incident — and it
still would not solve the real constraint, which is that the analysis stream is
downscaled to 640 px across the whole scene. Sending a full-resolution vehicle
crop to a dedicated 5 MB localizer does solve it, and costs nothing when no
vehicle needs reading.

No real traffic evaluation in this project has demonstrated a missed-object
problem in YOLO26s, so there is no evidence to justify the change. If one is
ever measured, that is the point to revisit it — on that evidence, not on the
assumption that a bigger detector would have helped here.

## Bounds

Plate work is the lowest-priority work in the system, enforced independently at
three layers so no single bug can lift the ceiling.

| Bound | Value | Enforced by |
| --- | --- | --- |
| Plate tasks in flight, system wide | 1 | camera, relay and worker |
| Candidate crops per track | 4 | camera |
| Tracks under analysis at once | 8 | camera |
| Minimum interval between requests | 220 ms | camera and relay |
| Request timeout | 3 s | relay |
| Crop payload | ≤ 96 KiB, 640 px long edge | protocol schema |
| Minimum crop | 64 px long edge | protocol schema |

The worker admits a plate task **only** when no analysis frame is running and
none is waiting. A plate request that arrives at any other moment is refused
immediately rather than queued, so plate work can never accumulate in front of
the next analysis frame.

A plate timeout does **not** condemn the worker. Analysis frames do, because an
overrun native call cannot be cancelled — but taking traffic detection down over
an unreadable plate is precisely the wrong trade. The relay reports the timeout,
disables plate work for the rest of that lease, and leaves analysis running.

## Format validation and ambiguous glyphs

A reading is folded to `A-Z0-9`, bounded to 2–10 characters, and checked against
a conservative pattern. Case and separators are presentation and are normalised
away. Anything else in the string — a state name, a slogan, part of a dealer
frame — is dropped the same way a hyphen is.

Ambiguous glyph pairs are **not** substituted. `0/O`, `1/I`, `5/S`, `8/B`,
`2/Z`, `6/G` and `7/T` are exactly the characters a substitution table would
"correct", and correcting one on a single reading turns a guess into an
assertion. Instead, readings that could be the same plate are grouped for
*voting*, and each character position is then decided by a weighted vote among
the characters actually observed there. Agreement across independent frames is
evidence; a lookup table is not.

No regional regex is applied. A single state's plate format would reject valid
plates from every other state, and RoadLens has no way to know which state it is
looking at.

## Consensus

Readings are weighted by OCR confidence and crop quality. Frames that read
nothing are counted too, as evidence against a lone confident reading. A result
is published only when at least 2 frames support it and the combined confidence
clears 0.55. Otherwise `plateText` is `null` and the UI says "Unreadable".

Worked example, matching the unit tests:

| frame | reading | confidence |
| --- | --- | --- |
| 1 | `ABC1234` | 0.95 |
| 2 | `ABCI234` | 0.66 |
| 3 | `ABC1234` | 0.93 |
| 4 | `ABC1234` | 0.89 |

`ABCI234` shares a shape with `ABC1234`, so it joins the vote rather than
forming a rival answer; position 4 is then decided 3-to-1 in favour of `1`.
Result: `ABC1234`, 4 supporting frames.

Characters are never invented. Readings of different lengths cannot share a
shape, so they never merge into a padded compromise — the better supported
length simply wins.

## Privacy

Plate recognition changes nothing about RoadLens being ephemeral.

- Plates are read only for qualified vehicles. "Every tracked vehicle" exists as
  an explicit testing mode and is not the default.
- The worker retains nothing between requests: no crop, no reading, no track.
- The phone holds crops, readings and consensus in RAM only, keyed by capture
  epoch. A new source, a seek, or End session discards all of it.
- No plate database, no cloud archive, no analytics, no `localStorage`, and no
  plate string is ever written to the console.
- Report plate fields live in RAM until the operator explicitly exports. Exports
  are user-owned files and cannot be revoked.
- The overlay never draws plate text over vehicles. Plates appear only in a
  report card and its detail view, which is both less cluttered and less
  exposed.

## Evaluation

One reproducible command, with the domain attached to every result:

```powershell
# Build the licensed public datasets once (ignored by Git).
node scripts/worker-python.mjs training/plates/openimages.py
node scripts/worker-python.mjs training/plates/openalpr_us.py --region us

# Localization only, on the held-out Open Images test split.
npm run plate:eval -- --suite openimages

# US domain: detector, and end-to-end plate text.
npm run plate:eval -- --suite us --output docs/evidence/plate-eval-us.json

# Which preprocessing actually helps, on ground-truth crops.
npm run plate:eval -- --suite us --compare-preprocessing

# OCR engines head to head.
npm run plate:ocr-bench
```

`--domain` travels with every result file. A global localization set says
nothing about US plate text, and the tooling will not let a report imply
otherwise.

Detector recall is additionally broken out by plate width in source pixels
(`0-24`, `24-48`, `48-96`, `96+`), because aggregate mAP hides exactly the small
plates that matter most in traffic footage.

### Evaluating on your own images

No code changes are needed. Put consented or permitted images in
`training/data/plates/user_eval/` together with a `truth.csv`:

```csv
image,x,y,width,height,text
front-01.jpg,935,362,99,49,YG9X2G
front-02.jpg,,,,,7ABC123
```

`x,y,width,height` are optional — supply them to measure detection as well as
reading; leave them empty to measure end-to-end reading only. Then:

```powershell
npm run plate:eval -- --suite user --domain "Consented parking-lot samples, California"
```

The directory is ignored by Git. Nothing you put there is committed, and this
project will not accept a pull request containing plate photographs.

## Physical test mode

Plate recognition can be exercised without any speeding vehicle, which is the
point: development must not require unsafe road interaction.

1. Mount or hold the camera somewhere safe, off the roadway, pointed at
   stationary or lawfully observable vehicles — a car park is ideal.
2. Start the camera with the GPU worker connected.
3. In Settings → Plate recognition, choose **Every tracked vehicle (testing)**.
   This is an explicit, labelled testing mode.
4. Save an observation for a vehicle whose plate you can read yourself.
5. Compare the reported plate against what you read, and record the pair.

For a repeatable record, photograph the same vehicles, drop the images and your
own transcriptions into `training/data/plates/user_eval/`, and run the `user`
suite above. That gives exact-match and character accuracy on images the models
have certainly never seen — which is the one thing the public benchmark cannot
give.

## What these measurements cannot tell you

- Open Images carries no plate text. It supports localization claims only.
- The OpenALPR US set is 222 single frames of mostly well-framed vehicles. It
  cannot exercise multi-frame consensus, motion blur, or roadside geometry.
- The OCR model's training corpus is not published, so it cannot be ruled out
  that this public benchmark was part of it. Treat the US figure as an upper
  bound and re-measure on your own images.
- Nothing here has been measured against moving traffic from a phone at the
  roadside. Until that happens, the physical validation line in
  [PLATE_RESULTS.md](PLATE_RESULTS.md) reads NOT VERIFIED.
- Plate readings are a review aid for a human. They are not an identification
  and never an automated citation.
