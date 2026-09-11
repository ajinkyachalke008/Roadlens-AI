# Release verification ledger

This is the release-hardening run, separate from the archived implementation baseline. Test doubles are labeled; real browser-model inference and real relay tests are explicitly distinguished.

## Completed release checks

| Command | Observed result |
|---|---|
| npm ci | PASS:273 installed,277 audited,0 reported vulnerabilities |
| npm run model:prepare | PASS: both packaged ONNX models and matching ORT1.29 assets verified |
| npm run typecheck | PASS |
| npm run lint | PASS |
| npx vitest run tests/unit tests/contracts tests/integration |173 PASS across7files,6.46s:106 unit +34 contracts +33 real relay integration |
| npm run test:model |11 PASS after inference hardening; actual WASM worker,416/320, portrait/landscape reference parity, production worker |
| node scripts/check-no-persistence.mjs | PASS:32 application modules |
| npm run deploy:verify | PASS: split/single Render and every configured Vercel schema property |
| training/.venv/Scripts/python -m unittest discover -s training -p test_*.py -v |21 PASS,0.132s; synthetic validation/safeguard fixtures, no training |
| node scripts/smoke-split.mjs --checks-only | PASS: production HTTPS asset integrity/MIME, exact-origin CORS and WSS rejection; browser intentionally skipped in this preliminary run |
| Gitleaks8.30.1 pre-staging scan | PASS: no secrets in153 project text files; generated/private directories inventoried and excluded |
| git diff --cached --check | PASS |

Final browser and production checks are recorded below; cloud results are separate. Prior baseline also ran each documented unit/contract/integration script separately. Repeated tests do not count as distinct features.

## Reproductions and fixes

Measurement eligibility, lost-track capacity and report selection defects have regression coverage in MEASUREMENT_RELEASE_AUDIT.md. Model watchdog/manifest and optional training safeguards are recorded in OPTIONAL_FEATURES_AUDIT.md. Relay canceled correlations, owner reconnect and serialized snapshots are recorded in RELAY_RELEASE_AUDIT.md.

New browser fault injection initially closed Vite's development HMR socket as well as the relay. The corrected test targets only /ws and keeps real report-content equality assertions. Download cleanup checks now wait for the existing1second object-URL revocation deadline. Neither change substitutes fabricated data. The focused real200-report offline/resync/stop/re-pair/End scenario passed13.2seconds after correction.

A cold --force reproduction on Vite8.3 logged the worker-only onnxruntime-web/wasm dependency arriving after initial optimization, followed by an optimized-dependency page reload. Explicitly including that dependency at startup fixed the cause. The cold-force full9-scenario rerun passed with no optimizer reload. Expanded room-heavy tests now reserve the real3-per-minute creation quota instead of relaxing the relay limit. See https://vite.dev/guide/dep-pre-bundling. No failing assertion was removed.

## External verification

Full cloud smoke, deployed relay restart and physical-phone/cellular/second-network checks remain NOT RUN until an authorized hosted relay exists. Real-field speed accuracy is UNMEASURED. OCR and wrong-way are disabled. Custom training and promotion were not executed.

## Final browser and production gate

- ROADLENS_TEST_FORCE_OPTIMIZE=1 npm run test:privacy: source scan32modules plus9/9 E2E PASS,1.4minutes. Includes real delayed-result416→320 adaptation, source offline/full200-report equality/re-pair, BFCache settings reset and native simulated camera.
- npm run build: PASS, assets/hashes/TypeScript/compiled relay/Vite.
- npm run test:model:11/11 PASS,6.7seconds; final41697.1–98.2ms,32071–78.6ms desktop per-photo timings.
- npm run test:production:1/1 real paired browser flow PASS,11.8seconds, plus compiled health/assets/hash/MIME/404 checks.
- npm run test:split-production:1/1 real paired browser flow PASS plus distinct HTTPS frontend/relay, WSS, exact-origin CORS and rejected unrelated/local aliases. Ephemeral test TLS certificates do not establish public hosting.
- Latest360/390/430/1440px layout assertions passed; updated390px/desktop screenshots visually inspected. Code-free local screenshots are excluded from the source release.
