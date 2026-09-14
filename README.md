# RoadLens AI 🚗⚡

<div align="center">

[![Live Demo](https://img.shields.io/badge/Live_Demo-roadlens--ai--lime.vercel.app-00C7B7?style=for-the-badge&logo=vercel&logoColor=white)](https://roadlens-ai-lime.vercel.app)
[![React](https://img.shields.io/badge/React_19-20232A?style=for-the-badge&logo=react&logoColor=61DAFB)](https://react.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Vite](https://img.shields.io/badge/Vite-646CFF?style=for-the-badge&logo=vite&logoColor=white)](https://vitejs.dev)
[![ONNX Runtime Web](https://img.shields.io/badge/ONNX_Runtime_Web-005CED?style=for-the-badge&logo=onnx&logoColor=white)](https://onnxruntime.ai/)
[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg?style=for-the-badge)](LICENSE)

**Privacy-first, in-browser traffic monitoring and vehicle analytics powered by WebAssembly and YOLO.**

[🌐 Open Live App](https://roadlens-ai-lime.vercel.app) · [💻 GitHub Repository](https://github.com/ajinkyachalke008/Roadlens-AI) · [📖 Documentation](docs/)

</div>

---

## 📖 About RoadLens AI

**RoadLens AI** transforms any standard web browser, smartphone camera, laptop webcam, or CCTV footage into an intelligent edge-computing traffic camera. 

Unlike traditional cloud video solutions that stream sensitive camera feeds to remote third-party servers, RoadLens executes computer vision neural networks **directly inside the client's browser** via WebAssembly (WASM). No cloud GPU subscription, app store download, or account registration is required.

### 🌟 Why RoadLens AI?
* **Edge-First Intelligence**: All detection and vehicle tracking runs client-side using **ONNX Runtime Web**.
* **Zero Cloud Storage & 100% Ephemeral**: Raw video frames and detection statistics exist only in device RAM during the active session. Closing the browser tab securely clears all state.
* **Mobile Ready**: Built to run seamlessly on mobile phones mounted on a tripod, dashboard, or window, utilizing the device's rear camera.

---

## ✨ Key Features

| Feature | Description |
| :--- | :--- |
| 🎯 **Multi-Class Vehicle Detection** | Accurately identifies **Cars, Trucks, Buses, Motorcycles, Bicycles, and Pedestrians** using a custom YOLO26n model. |
| ⚡ **Speed & Trajectory Estimation** | Measures estimated vehicle speeds (km/h or mph) using camera planar calibration and a custom `time_aware_iou_v1` tracking algorithm. |
| 📱 **Mobile Rear-Camera Mode** | Automatically engages the environment-facing lens on iOS Safari and Android Chrome with adaptive resolution scaling (416px / 320px). |
| 📹 **CCTV & Video Replay Mode** | Upload pre-recorded dashcam, phone, or CCTV footage to analyze traffic metrics frame-by-frame offline. |
| 📊 **Session Reports & Data Export** | Generates real-time traffic volume logs, speed candidate flags, and instant **CSV / JSON** data exports for spreadsheet analysis. |
| 🔗 **Multi-Device Pairing (Optional)** | Pair a phone camera with a remote laptop viewer in real-time via an 8-character Crockford Base32 room code (`XXXX-XXXX`) through a lightweight relay. |
| 🏎️ **Local GPU Worker (Optional)** | Connect an optional local computer with an NVIDIA GPU for high-resolution vehicle cropping and License Plate Recognition (ALPR/OCR). |

---

## 🚀 Live Preview & Deployment

### 🌐 Live Production Application
Access the production application directly:
👉 **[https://roadlens-ai-lime.vercel.app](https://roadlens-ai-lime.vercel.app)**

### 📱 Testing on Mobile:
1. Open [https://roadlens-ai-lime.vercel.app](https://roadlens-ai-lime.vercel.app) on your phone.
2. Grant camera permissions (served over secure HTTPS).
3. Point your camera at a roadway, or select **Settings → Use replay video** to run inference on a sample clip!

---

## 🛠️ Tech Stack

* **Frontend Framework**: [React 19](https://react.dev) + [TypeScript](https://www.typescriptlang.org)
* **Build Tool**: [Vite 8](https://vitejs.dev)
* **Computer Vision & Inference**: [ONNX Runtime Web (WASM)](https://onnxruntime.ai/) running YOLO26n FP32
* **Tracking Algorithm**: Custom `time_aware_iou_v1` tracker inspired by ByteTrack
* **Backend Relay (Optional)**: [Node.js](https://nodejs.org) + [Express](https://expressjs.com) + [ws (WebSockets)](https://github.com/websockets/ws)
* **Hosting**: [Vercel](https://vercel.com) (Static Frontend)

---

## 💻 Local Development Setup

### Prerequisites
* **Node.js**: >= 24.13.0 (or LTS 22.x/24.x)
* **npm**: >= 11.0.0

### Quickstart

```bash
# 1. Clone the repository
git clone https://github.com/ajinkyachalke008/Roadlens-AI.git
cd Roadlens-AI

# 2. Install dependencies
npm ci

# 3. Prepare and verify packaged ONNX model assets
npm run model:prepare

# 4. Start local development server
npm run dev
```

Open [http://127.0.0.1:5173](http://127.0.0.1:5173) in your browser.

---

## 🧪 Test & Validation Suite

```bash
# Typecheck & linting
npm run typecheck
npm run lint

# Unit and contract tests
npm run test:unit
npm run test:contracts

# Production bundle validation
npm run build
npm run deploy:verify
```

---

## 🔒 Privacy & Data Policy

* **Zero-Persistence Guarantee**: There is no database, cloud telemetry, or third-party tracking.
* **Client-Authoritative**: Speed measurements, tracking calculations, and reports originate strictly in your device's memory.
* **Export Ownership**: Only the operator can export data through explicit CSV/JSON download buttons.

---

## 📄 License

This project is licensed under the [GNU Affero General Public License v3.0 (AGPL-3.0)](LICENSE). Third-party runtime notices and attributions are detailed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

---

<div align="center">
  <b>Built by <a href="https://github.com/ajinkyachalke008">Ajinkya Chalke</a></b> · RoadLens AI
</div>
