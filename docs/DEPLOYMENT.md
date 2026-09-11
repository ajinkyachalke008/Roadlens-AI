# Deployment

## GPU extension

The optional local Windows worker connects outbound to `wss://<actual-relay>/worker`; camera GPU frames use `/gpu`, while original camera/viewer pairing remains `/ws`. All three terminate on the same ordinary Node process. Both Render blueprints now declare ROADLENS_WORKER_SECRET as an operator-supplied private environment value. Copy the same secret only into ignored .env.worker; Vercel receives no worker credential. Leave the backend value unset to disable GPU registration. No Python package/model is installed by the relay build.

Camera start uses a strict Origin-validated POST /api/config read to prefer a ready GPU. The same-origin GET omission of Origin is not bypassed. Public status exposes only enabled/ready/busy/offline, never machine identifiers or room listings.

Configure Vercel exactly as below once the relay is authorized. Existing frontend-only VITE_SHARING_DISABLED=true also disables GPU discovery/transmission; the current public release stays usable with browser inference. Existing ALLOWED_ORIGINS must remain the exact Vercel origin, and the worker URL must be WSS with no credentials/query. No inbound local listener or tunnel is needed.

Current official [Render free-instance terms](https://render.com/docs/free) and [bandwidth terms](https://render.com/docs/outbound-bandwidth) were rechecked during this upgrade: payment-method workspaces can incur supplementary bandwidth charges; WebSocket egress counts. GPU image forwarding increases egress and shares existing room/process byte caps. The prior strict no-overage blocker therefore remains; no billing/resource workaround was applied. Start the worker only for actual work/demo and stop it afterward; its active connection heartbeat consumes free service hours and is not advertised as free unlimited video hosting.

After deploying both authorized components: configure ignored .env.worker, run .\start.ps1, wait for actual authenticated readiness, open public camera, confirm GPU frame results, pair a viewer and test fallback by stopping the worker. Run cloud smoke and repeat after relay restart. Stop local dev services while leaving the intentional GPU worker running. A local GPU test does not establish production WSS or physical phone performance.

Vercel production frontend: https://roadlens-ai-five.vercel.app (project roadlens-ai, Hobby). Public application source: https://github.com/kokoc30/roadlens-ai. The static deployment passed asset and dual-profile browser smoke. One Render Free relay process is prepared but not deployed. See FINAL_HANDOFF.md for actual URLs and completed checks. Configuration readiness does not establish a cloud deployment.

## Current authorization boundary

The application-source release is authorized; see RELEASE_APPROVAL.md. Vercel Hobby account access is available. Read-only inspection of the authorized Render account shows a payment method and explicit billing beyond included allowances. The user's strict no-overage condition therefore blocks creation of a Render service. No plan, payment method, billing setting or unrelated project was changed.

[Render free services](https://render.com/docs/free) can spin down after15 idle minutes. [Outbound WebSocket traffic](https://render.com/docs/outbound-bandwidth) consumes bandwidth. [Vercel Hobby](https://vercel.com/docs/plans/hobby) is for personal/non-commercial use. Verify current eligibility and account limits before creating resources. No trial credits or anti-sleep bots are used.

The relay's128MiB room and256MiB process-boot content limits include viewer fanout. They exclude transport overhead, other services and static downloads and reset with the process. They cannot guarantee an account-level monthly bill.

## Frontend-only release while relay is blocked

Use the existing vercel.json: repository root, npm ci, npm run build, output frontend/dist, Vite, Node24. Set build environment VITE_SHARING_DISABLED=true. Leave VITE_API_BASE_URL empty. This publishes real camera/replay inference and temporary local reports, with Share/Connect disabled and an explicit status. It provides no remote viewing until an approved relay is deployed. It is not a successful full cloud smoke.

The static application contains matching model/runtime assets. No WebSocket server or neural network runs in Vercel Functions. Do not deploy backend output as a Vercel function.

## Deployment order when plate support changes

Deploy **Vercel first, then Render, then restart the GPU worker.** Every hop
negotiates plate support, so no order can break anything permanently, but this
one is the only one with no visible interruption at all.

`worker.registered` carries `plateProtocol: 1` only from a relay that
understands plate messages, and the worker advertises its plate pipeline only
after seeing it. This matters more than it looks: `worker.ready` is a strict
schema, so a worker announcing `plate` to an older relay would be rejected and
dropped on every reconnect — costing the operator GPU analysis entirely, not
merely plate reading. Negotiating at registration turns that from a mandatory
upgrade order into a non-event, and
`tests/integration/plates.test.ts` plus `worker/tests/test_plate_connection.py`
both hold that behaviour in place.

The camera likewise sends a plate request only after a `gpu.status` that
advertises a plate pipeline, and only an updated relay ever advertises one. A new
frontend against an old relay therefore never sends one: plate recognition
reports unavailable while traffic analysis, sharing and reports continue
untouched.

The one residual cost is a stale browser tab. A new relay paired with a
plate-capable worker sends `gpu.status` carrying `plate`, and a browser still
running a cached older bundle rejects the unknown field and drops to browser
inference until it is reloaded. Deploying the frontend first is what avoids it.

`render.yaml` sets `autoDeployTrigger: off`, so pushing to `main` does **not**
deploy the relay. It must be deployed explicitly from the Render dashboard.
Until that happens the worker simply never advertises plate support and the
reports read "Plate unavailable".

## Complete split deployment once free-only authorization exists

1. Supply an authorized Render workspace whose no-overage behavior is verified. Do not bypass the current restriction or modify unrelated services.
2. Create one new Node service from render.yaml, free plan, one instance, npm ci && npm run build:relay, npm run start, health /healthz. No disks, database, add-ons or GPU. Render supplies PORT; server binds0.0.0.0.
3. Set production ALLOWED_ORIGINS to the exact Vercel HTTPS origin, without a trailing slash. Never use a wildcard. Production rejects unrelated and localhost origins unless explicitly configured for an isolated test.
4. Set Vercel VITE_API_BASE_URL to the actual relay HTTPS origin and VITE_SHARING_DISABLED=false. Rebuild. The browser uses WSS directly to the relay.
5. Verify model/runtime MIME, bytes and SHA-256, exact origins and role-bound pairing, then run the full smoke below. Record actual URLs; do not invent a default.

## Single-Render fallback

Use render.single.yaml instead of the split blueprint, only after the same free-only constraint is resolved. Build npm ci && npm run build, start npm run start, SERVE_WEB=true, VITE_API_BASE_URL empty, VITE_SHARING_DISABLED=false, exact service HTTPS origin in ALLOWED_ORIGINS. The same process serves public assets and the RAM relay. Static asset downloads also consume Render bandwidth.

## Validation

npm run deploy:verify validates both Render files against the official complete schema. It validates every configured Vercel property against the official property schema and rejects unknown fields; the upstream schema has an unrelated invalid draft04 experimentalTriggers branch.

npm run test:production starts and stops the compiled single-process application locally and executes the real-model paired browser test. Local tests do not prove provider restart or physical-phone behavior.

After both deployments actually exist:

```powershell
$env:ROADLENS_BASE_URL='https://<actual-frontend-origin>'
$env:ROADLENS_RELAY_URL='https://<actual-relay-origin>'
npm run smoke:cloud
```

The command rejects missing/localhost origins, checks HTTPS/model/runtime integrity and runs the real analyzed-preview/report flow. Restart the actual deployed relay separately, verify the old code fails, then create a new room from the still-open camera and pair again. Stop development services before a physical phone/cellular + separate-network viewer trial.

Additional delivered commands: npm run test:split-production builds isolated production assets and exercises real paired browsers through distinct local HTTPS/WSS origins. It requires OpenSSL (or ROADLENS_OPENSSL pointing to its executable); temporary self-signed certificates are scoped to loopback tests and cleaned up. npm run smoke:frontend with ROADLENS_BASE_URL checks a real public camera-only deployment against the source-controlled manifests and executes the @frontend real-inference/local-report flow. Neither substitutes for smoke:cloud.
