# Plate datasets and models: what was used, and what it can support

Every number RoadLens publishes about plate recognition has to be traceable to a
dataset whose licence and origin are known. This file records that chain. It
also records what each source *cannot* support, because the most common way an
ALPR claim goes wrong is measuring on one domain and reporting as if it were
another.

No plate photograph is committed to this repository. Both datasets below are
fetched on demand into `training/data/plates/`, which is ignored by Git.

## Chosen: Open Images V7 — "Vehicle registration plate"

| | |
| --- | --- |
| Name | Open Images V7, class `Vehicle registration plate` (`/m/01jfm_`) |
| Source | Google LLC; images mirrored by the Common Visual Data Foundation |
| Annotation licence | CC BY 4.0 (annotations are licensed by Google LLC) |
| Image licence | CC BY 2.0 (Flickr); Google states it cannot guarantee the licence status of any individual image |
| Geography | Global, including North America |
| Plate format | Not applicable — boxes only |
| Images used | 5,365 train · 721 validation · 2,054 test (8,140 total) |
| Instances | 7,846 · 982 · 2,824 (11,652 plate boxes) |
| Annotations | Human-verified bounding boxes. `IsGroupOf` and `IsDepiction` instances are discarded by `training/plates/openimages.py`: a group box is a cluster rather than a plate, and a depiction is a picture of one. |
| Commercial / hackathon use | Yes, with attribution |
| Why it was chosen | It is the largest plate-localization set with unambiguous, verifiable provenance, and it ships an official train/validation/test partition. Using that partition verbatim is what makes leakage impossible: an image belongs to exactly one split upstream, so no reshuffle of ours can put neighbouring frames of one vehicle on both sides. |
| Limitations | **It contains no plate text at all.** Open Images deliberately annotates plates as objects and never transcribes them. It therefore cannot support any OCR accuracy claim, US or otherwise. It is also a global mix, so class balance does not reflect North American plate layouts. |

## Chosen: OpenALPR end-to-end benchmark, US subset

| | |
| --- | --- |
| Name | OpenALPR benchmarks, `endtoend/us` |
| Source | https://github.com/openalpr/benchmarks |
| Licence | AGPL-3.0 — the same licence as RoadLens, so use is permitted |
| Geography | United States |
| Plate format | US state plates |
| Images | 222 photographs, 222 annotated plates |
| Annotations | Plate bounding box (`x y width height`) and ground-truth plate text |
| Commercial / hackathon use | Permitted under AGPL-3.0. **Not redistributed here.** These are photographs of real vehicles, so `training/plates/openalpr_us.py` downloads them on demand into an ignored directory and nothing is committed. |
| Why it was chosen | It is the only properly licensed US-domain source with plate *text*, so it is the only basis on which this project may state a US exact-match or character accuracy. |
| Limitations | Small (222 plates), so a single misread moves the reported rate by 0.45 points. Every image is a single frame, so it cannot exercise multi-frame consensus at all. Framing is closer to a photograph of a parked or approaching vehicle than to roadside traffic geometry, so it is an optimistic proxy for field conditions. The `eu` and `br` subsets are reachable through the same tool for secondary domains. |

## Considered and not used

| Dataset | Why not |
| --- | --- |
| UFPR-ALPR | Released for academic research only, non-commercial, with an explicit no-redistribution agreement. Not usable for this project. |
| CCPD | Large and well annotated, but Chinese plates. Usable at most for localization pretraining, and it could not support a US OCR claim, so it adds licence and provenance surface for no reportable benefit. |
| Roboflow Universe plate datasets | Aggregations whose individual image provenance is not documented per image. Rejected on provenance grounds, not on licence text. |
| `ankandrew/open-image-models` YOLOv9 plate weights | MIT-licensed code and a convenient ONNX detector, but the published model cards do not name the dataset the detector was trained on. That is exactly the "checkpoint without provenance" this project refuses to ship. It remains a reasonable alternative for anyone who does not need the provenance record. |

## Models

### Plate detector — trained here

| | |
| --- | --- |
| Architecture | YOLO26n, single class `license_plate`, 640 px |
| Base weights | Official Ultralytics YOLO26n, AGPL-3.0, SHA-256 pinned in `worker/model-catalog.json` and re-verified before training starts |
| Training data | Open Images V7 plate subset above |
| Licence | AGPL-3.0, inherited from the Ultralytics base weights — the same licence as RoadLens |
| Artifact record | `worker/plate-catalog.json` pins filename, byte length and SHA-256. The worker refuses to load any plate artifact that does not match. |

The detector is separate from YOLO26s on purpose. The traffic model is never
asked to know about plates or text; making one model do both would mean growing
the model that runs on every frame in order to serve work that runs on a handful
of frames per incident.

### OCR — selected by measurement

`fast-plate-ocr` 1.1.0 (MIT), model `cct-s-v2-global-model`, ONNX Runtime with
the CUDA execution provider. Selected on measured results, recorded in
[PLATE_VALIDATION.md](PLATE_VALIDATION.md).

**Provenance limitation, stated plainly:** the corpus behind
`cct-s-v2-global-model` is not published. This is a weaker provenance record
than the detector's, and it is accepted deliberately: the alternative measured
more than 29 points worse. Because the corpus is unknown, it is also not
possible to rule out that the OpenALPR US benchmark — a public dataset — was
part of it. The US accuracy figure should therefore be read as an upper bound,
and the operator evaluation path in
[PLATE_VALIDATION.md](PLATE_VALIDATION.md) exists precisely so it can be checked
against images the model has certainly never seen.

## Attribution

Open Images V7 annotations © Google LLC, CC BY 4.0. Open Images photographs are
individual Flickr works under CC BY 2.0, held by their respective authors.
OpenALPR benchmark images are distributed under AGPL-3.0 by the OpenALPR
project. Ultralytics YOLO26 weights are AGPL-3.0. `fast-plate-ocr` and
`RapidOCR` are MIT and Apache-2.0 respectively; see
[THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).
