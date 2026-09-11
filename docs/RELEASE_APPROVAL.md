# Release authorization and boundary

The September 10, 2026 release-hardening request explicitly authorizes preparing and publishing the application repository when authentication is available. The selected official YOLO26n assets carry AGPL-3.0 terms. Following the existing release conclusion and [publisher guidance](https://www.ultralytics.com/license), the newly implemented application, configuration and tests are released under AGPL-3.0 with corresponding source and preserved notices.

Original instruction packs, research, private environments, datasets and generated test captures are preserved locally and excluded from the public application repository. No enterprise license was purchased. This decision does not relicense those excluded materials.

GitHub authentication is available for the intended owner; the requested repository name is roadlens-ai. Application source was published at https://github.com/kokoc30/roadlens-ai and verified, release commit c1f32553509918fae55a9eea86a78f06f8ab9099. See FINAL_HANDOFF.md for deployment results.

Render creation is explicitly blocked by the user's no-overage requirement: read-only inspection of the authorized account shows billable usage beyond included allowances. No billing or unrelated service settings were changed. A suitable authorized workspace with verified no-overage behavior is required before creating the relay. Application byte caps do not guarantee provider billing limits.

Vercel Hobby static hosting can provide the camera-only application while this remains unresolved. Such a deployment must set VITE_SHARING_DISABLED=true and visibly disable pairing. It is not a completed two-device cloud deployment.
