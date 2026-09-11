# RoadLens release status

Release-hardening run, September10–11,2026. This repository contains the actual application, locked dependencies, real model assets, tests and free-hosting configurations. Physical-phone and field-speed verification remain separate external gates.

## Initial state and preservation

The original implementation run began with specification files only and no Git repository. The release-hardening run began with a substantial working application but no Git metadata. It first reran the complete clean baseline: npm ci/model preparation/typecheck/lint,88 unit,34 contract,25 relay integration,11 real browser-model,6 E2E,6 privacy E2E, production build, compiled paired smoke and deployment schema checks all passed. No supplied checklist was treated as proof.

Git is now initialized on main. The latest request authorizes application-only AGPL source publication. Original requirements, specialist packs and research remain preserved locally, excluded from the release. Earlier generated handoff/status files are archived privately for continuity. No global configuration, billing changes, force-push, reset or unrelated project modification occurred.

## Release fixes

- Prevented background-unverified observations from entering later speed history; kept all sampling/coverage/residual gates unchanged.
- Reclaimed lost-track capacity for currently observed new objects while preserving bounded arrays and monotonic IDs.
- Validated frozen report facts/policy and explicit object selection; empty observations keep null speed with a reason.
- Added bounded model load/inference watchdogs, exact decoder/preprocessing manifest checks and malformed-dimension rejection.
- Added measured416→320 adaptation, bounded analysis scheduling, source-stall clearing, replay→device-camera control, and mph/km/h display/settings.
- Tightened canceled request handling and owner reconnect snapshots, serializing competing viewer state requests.
- Hardened optional training dataset/resume/promotion validation.21 synthetic safeguard tests pass; no training ran.
- Added a frontend-only deployment mode that visibly disables sharing when no authorized relay exists.

## Current release gates

Final cold-start privacy/E2E passes9/9; production build,11 model tests,1 compiled same-origin and1 split-origin HTTPS/WSS real paired browser flow pass. Exact command results are in RELEASE_RESULTS.md. Application commit c1f32553509918fae55a9eea86a78f06f8ab9099 is public at https://github.com/kokoc30/roadlens-ai. Vercel frontend-only production https://roadlens-ai-five.vercel.app is Ready and passed real dual-profile browser/local-report smoke. Model hashes are unchanged; the final11 real-model browser tests passed in6.7seconds. The pre-staging Gitleaks8.30.1 scan found no secrets in149 project text files, including preserved instructions; generated dependencies/environments were inventoried and excluded from publication.

Render creation remains blocked: the authorized account explicitly permits billable overages, which violates the user's strict no-overage condition. Do not create a service until a suitable authorized workspace is verified. Vercel frontend-only release is deployed at https://roadlens-ai-five.vercel.app, with sharing explicitly disabled. The public smoke passed1/1 in9.2seconds; no local service was running. Full cloud pairing remains NOT RUN.

Physical rear-camera behavior, sustained phone performance, cellular/second-network pairing, deployed relay restart and field ground-truth accuracy remain unverified. OCR and wrong-way are disabled; custom training/promotion did not run.
