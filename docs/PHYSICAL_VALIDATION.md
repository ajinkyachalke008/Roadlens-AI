# Physical validation

Everything in this release that can be verified without a camera in the street
has been. This file covers what cannot, and states plainly what is therefore
still unmeasured.

Nothing below has been performed yet. Rows marked **NOT VERIFIED** must stay
that way in every status document until someone runs them and records numbers.

## Safety and legality first

- Stand on a footpath, verge or private parking area. Never in a traffic lane.
- Do not obstruct the footpath or the driver's view.
- Point the phone at traffic, not at people, homes or windows.
- A parked or slow-moving vehicle you have permission to photograph is the right
  subject for plate tests. Do not stage anything in moving traffic.
- Speed readings from this tool are demo measurements against an
  operator-entered limit. They are not evidence, not a citation, and the UI says
  so.

## A. Track continuity — handheld

**Status: NOT VERIFIED**

The primary product claim of this release: one physical vehicle keeps one ID
while continuously observed.

1. Start the camera. Confirm the badge reads `Handheld · speed unavailable`.
2. Pick one vehicle and follow it for as long as it is in view.
3. Tap it. Note the ID in the selected card.
4. Watch the ID in the overlay label for the whole pass.

Record per vehicle:

| field | how |
| --- | --- |
| vehicle description | "silver hatchback", no plate text needed |
| seconds observed | selected card, `Observed` |
| ID at start / at end | overlay label |
| ID changes during the pass | count them |
| analysis Hz | metrics strip |
| GPU or browser | inference badge |

Do at least 10 vehicles, including one motorcycle and one distant vehicle.

**Pass:** the large majority of continuously observed vehicles keep one ID, and
any change coincides with the vehicle being genuinely hidden or leaving frame.
Compare against `docs/TRACKING_EVALUATION.md` §5, which predicts 1.00 IDs per
vehicle on synthetic traffic and 1.11 under adversarial conditions.

**Note:** an ID change after a vehicle fully exits and re-enters is correct
behaviour, not a failure. Do not count it.

## B. Handheld intelligence

**Status: NOT VERIFIED**

With a vehicle selected, confirm each row is populated and sane:

- class and ID; class should not flicker between `CAR` and `TRUCK`
- detection confidence
- tracking state reaching `confirmed`
- observed duration increasing
- motion matching reality (`Moving left`, `Approaching`, …)
- **speed reads `Mount and calibrate for speed` and shows no number at all**

The last one is the release's central safety property. If any mph appears while
handheld, stop and report it as a defect.

## C. Plate reading — selected vehicle

**Status: NOT VERIFIED**

Needs the GPU worker running with its plate pipeline (the `Analyze plate` button
is disabled otherwise).

For a parked or legally observed vehicle whose plate you can read yourself:

1. Tap the vehicle, then `Analyze plate`.
2. Wait for `Analyzing…` to settle.

Record:

| field | notes |
| --- | --- |
| ground truth | what you can read by eye |
| predicted text | as shown |
| confidence | as shown |
| plate pixel height / width | from the evidence frame |
| distance | paced or estimated |
| camera resolution | metrics strip |
| lighting | daylight / overcast / dusk / night |
| result | correct / wrong / unreadable |

Repeat at increasing distance until readings stop settling. **The output of this
test is the minimum practical plate pixel height for RoadLens**, which is
currently unknown and must not be quoted until measured.

`Unreadable` is a correct outcome, not a failure. A *wrong* plate read with high
confidence is a serious defect — record it prominently.

## D. Mounted speed

**Status: NOT VERIFIED**

1. Mount the phone so it cannot move. A clamp or a weighted tripod; not a hand,
   not a loose ledge.
2. `Calibrate`, and follow the measured-distance flow. Use a real measured
   distance, not an estimate.
3. Settings → enter the road's actual posted limit and a candidate margin.
4. Confirm the badge changes to `Mounted · speed active`.
5. Let traffic pass.

Confirm:

- overlay labels gain a speed: `CAR · ID 12 · 31.0 mph`
- a vehicle over limit + margin becomes a candidate and turns amber
- a speed candidate creates a report **without** anyone tapping
- the report carries measured speed, the entered limit, the amount over, the
  measurement quality and the exact evidence frame
- if plate consensus settles, the report gains the plate; if not, it stays
  `Plate unreadable` and does **not** hang

Then the authority test:

6. Pick the phone up, or nudge the mount.
7. Speed must stop immediately and the badge must fall back to
   `Mounted · speed unavailable` or `camera moved`.

If speed survives the camera being moved, that is a defect.

### Speed accuracy

**Status: NOT VERIFIED — no accuracy figure may be quoted**

Accuracy needs an independent reference: a vehicle whose own GPS track you have
with permission, or a second independently calibrated measurement. `Validate
speed` records paired readings for exactly this. Until a distribution of errors
exists, RoadLens speed is a *demo measurement*, and nothing in the product or
its documents should suggest otherwise.

## E. Fallback and recovery

**Status: NOT VERIFIED**

1. With GPU analysis running, stop the local worker.
2. Browser AI must take over; detection continues; the badge changes.
3. Restart the worker and reconnect.
4. Confirm analysis returns to GPU and that measurement continuity was reset
   across the switch rather than carried over.

## F. iPhone regressions

**Status: NOT VERIFIED on device** (covered by automated tests in Chromium)

- the preview stays smooth and native, not stepping at the analysis rate
- the frame clock advances past frame 0 on iOS Safari
- 30 and 60 FPS both behave
- rotating the device resets cleanly
- pause and resume work
- boxes sit exactly on vehicles, with no letterbox offset

## Recording results

Put findings in `docs/evidence/` as dated files, and update the status table in
`docs/STATUS.md`. Replace **NOT VERIFIED** only with a measurement, never with an
impression.
