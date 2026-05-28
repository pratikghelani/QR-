(() => {
  "use strict";

  const STORAGE_KEY = "warehouse_qr_scans_v1";
  const DUPLICATE_WINDOW_MS = 2000;

  const ui = {
    stockType: document.getElementById("stockType"),
    startBtn: document.getElementById("startBtn"),
    stopBtn: document.getElementById("stopBtn"),
    resetBtn: document.getElementById("resetBtn"),
    exportBtn: document.getElementById("exportBtn"),
    scannerStatus: document.getElementById("scannerStatus"),
    searchInput: document.getElementById("searchInput"),
    filterType: document.getElementById("filterType"),
    scanTableBody: document.getElementById("scanTableBody"),
    emptyState: document.getElementById("emptyState"),
    totalCount: document.getElementById("totalCount"),
    inCount: document.getElementById("inCount"),
    outCount: document.getElementById("outCount"),
    latestValue: document.getElementById("latestValue"),
    latestType: document.getElementById("latestType"),
    latestTime: document.getElementById("latestTime"),
    lastScanShort: document.getElementById("lastScanShort"),
    successPulse: document.getElementById("successPulse"),
    networkBadge: document.getElementById("networkBadge"),
    allowDuplicates: document.getElementById("allowDuplicates"),
    allowCameraBtn: document.getElementById("allowCameraBtn")
  };

  const state = {
    scans: [],
    scanner: null,
    isScanning: false,
    lastSeenByCode: new Map(),
    audioContext: null,
    hasCameraPermission: false
  };

  function init() {
    loadScansFromStorage();
    renderAll();
    wireEvents();
    updateNetworkBadge();
    checkCameraPermission();
  }

  function wireEvents() {
    ui.startBtn.addEventListener("click", startScanner);
    ui.stopBtn.addEventListener("click", stopScanner);
    ui.resetBtn.addEventListener("click", resetAllData);
    ui.exportBtn.addEventListener("click", exportToCsv);
    ui.searchInput.addEventListener("input", renderTable);
    ui.filterType.addEventListener("change", renderTable);
    if (ui.allowCameraBtn) {
      ui.allowCameraBtn.addEventListener("click", requestCameraAccess);
    }
    window.addEventListener("online", updateNetworkBadge);
    window.addEventListener("offline", updateNetworkBadge);
  }

  function loadScansFromStorage() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        state.scans = parsed.filter((item) => item && item.value && item.timestamp && item.stockType);
      }
    } catch (error) {
      console.error("Failed to parse saved scans:", error);
      state.scans = [];
    }
  }

  function saveScansToStorage() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.scans));
  }

  async function startScanner() {
    if (state.isScanning) return;
    if (!window.Html5Qrcode) {
      alert("QR scanner library failed to load. Check internet connection and retry.");
      return;
    }

    try {
      if (!state.hasCameraPermission) {
        const granted = await requestCameraAccess();
        if (!granted) {
          alert("Unable to access camera. Please allow camera permissions and retry.");
          return;
        }
      }

      const hasCamera = await Html5Qrcode.getCameras();
      if (!hasCamera || hasCamera.length === 0) {
        alert("No camera device found.");
        return;
      }
    } catch (error) {
      console.error("Camera list error:", error);
      alert("Unable to access camera list. Please allow camera permission for this site.");
      return;
    }

    if (!state.scanner) {
      state.scanner = new Html5Qrcode("qr-reader", {
        formatsToSupport: [Html5QrcodeSupportedFormats.QR_CODE],
        experimentalFeatures: { useBarCodeDetectorIfSupported: true }
      });
    }

    const config = {
      fps: 20,
      qrbox: (viewfinderWidth, viewfinderHeight) => {
        const side = Math.floor(Math.min(viewfinderWidth, viewfinderHeight) * 0.7);
        return { width: side, height: side };
      },
      rememberLastUsedCamera: true,
      aspectRatio: 1.777,
      disableFlip: false
    };

    const cameraConfig = { facingMode: "environment" };

    try {
      await ensureAudioReady();
      await state.scanner.start(cameraConfig, config, onScanSuccess, onScanError);
      state.isScanning = true;
      toggleScannerUi(true);
    } catch (error) {
      console.error("Scanner start failed:", error);
      alert("Camera start failed. Please allow camera permissions and retry.");
    }
  }

  async function stopScanner() {
    if (!state.scanner || !state.isScanning) return;
    try {
      await state.scanner.stop();
      await state.scanner.clear();
    } catch (error) {
      console.error("Scanner stop failed:", error);
    } finally {
      state.isScanning = false;
      state.scanner = null;
      toggleScannerUi(false);
    }
  }

  function toggleScannerUi(active) {
    ui.startBtn.disabled = active;
    ui.stopBtn.disabled = !active;
    ui.scannerStatus.className = active ? "badge text-bg-success" : "badge text-bg-secondary";
    ui.scannerStatus.textContent = active ? "Scanner Running" : "Scanner Stopped";
  }

  async function checkCameraPermission() {
    state.hasCameraPermission = false;
    if (navigator.permissions && navigator.permissions.query) {
      try {
        const status = await navigator.permissions.query({ name: "camera" });
        state.hasCameraPermission = status.state === "granted";
        status.onchange = () => checkCameraPermission();
      } catch (err) {
        state.hasCameraPermission = false;
      }
    }
    updateCameraUi();
  }

  async function requestCameraAccess() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      alert("Camera access is not supported in this browser.");
      return false;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      stream.getTracks().forEach((track) => track.stop());
      state.hasCameraPermission = true;
      updateCameraUi();
      return true;
    } catch (error) {
      console.error("Camera access denied or failed:", error);
      state.hasCameraPermission = false;
      updateCameraUi();
      return false;
    }
  }

  function updateCameraUi() {
    if (!ui.allowCameraBtn) return;
    if (state.hasCameraPermission) {
      ui.allowCameraBtn.classList.add("d-none");
      ui.startBtn.disabled = false;
      ui.allowCameraBtn.textContent = "Camera Allowed";
      ui.allowCameraBtn.classList.remove("btn-outline-primary");
      ui.allowCameraBtn.classList.add("btn-success");
    } else {
      ui.allowCameraBtn.classList.remove("d-none");
      ui.startBtn.disabled = true;
      ui.allowCameraBtn.textContent = "Allow Camera";
      ui.allowCameraBtn.classList.remove("btn-success");
      ui.allowCameraBtn.classList.add("btn-outline-primary");
    }
  }

  function onScanSuccess(decodedText) {
    const value = String(decodedText || "").trim();
    if (!value) return;

    const allowDup = ui.allowDuplicates && ui.allowDuplicates.checked;
    const alreadyScanned = state.scans.some((scan) => scan.value === value);
    if (!allowDup && alreadyScanned) {
      alert("Duplicate QR code detected. This code has already been scanned.");
      return;
    }

    const now = Date.now();
    state.lastSeenByCode.set(value, now);

    const stockType = ui.stockType.value;
    const timestamp = new Date().toISOString();
    const record = {
      id: `${now}-${Math.random().toString(36).slice(2, 8)}`,
      value,
      stockType,
      timestamp
    };

    state.scans.unshift(record);
    saveScansToStorage();
    updateLatestScan(record);
    renderStats();
    renderTable();
    triggerSuccessFeedback();
  }

  function onScanError() {
    // Ignore frequent decode misses for smooth scanning.
  }

  function formatTimestamp(isoString) {
    const dt = new Date(isoString);
    return dt.toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    });
  }

  function updateLatestScan(scan) {
    if (!scan) {
      ui.latestValue.textContent = "No scans yet";
      ui.latestType.textContent = "-";
      ui.latestTime.textContent = "-";
      ui.lastScanShort.textContent = "-";
      return;
    }
    ui.latestValue.textContent = scan.value;
    ui.latestType.textContent = scan.stockType;
    ui.latestTime.textContent = formatTimestamp(scan.timestamp);
    ui.lastScanShort.textContent = scan.value.slice(0, 12);
  }

  function animateCounter(element, endValue) {
    const startValue = Number(element.dataset.value || "0");
    const duration = 320;
    const start = performance.now();

    const frame = (now) => {
      const progress = Math.min((now - start) / duration, 1);
      const value = Math.floor(startValue + (endValue - startValue) * progress);
      element.textContent = String(value);
      if (progress < 1) {
        requestAnimationFrame(frame);
      } else {
        element.dataset.value = String(endValue);
      }
    };
    requestAnimationFrame(frame);
  }

  function renderStats() {
    const total = state.scans.length;
    const inTotal = state.scans.filter((s) => s.stockType === "IN").length;
    const outTotal = total - inTotal;

    animateCounter(ui.totalCount, total);
    animateCounter(ui.inCount, inTotal);
    animateCounter(ui.outCount, outTotal);
  }

  function getFilteredScans() {
    const query = ui.searchInput.value.trim().toLowerCase();
    const filter = ui.filterType.value;

    return state.scans.filter((scan) => {
      const typeMatch = filter === "ALL" || scan.stockType === filter;
      const queryMatch = !query || scan.value.toLowerCase().includes(query);
      return typeMatch && queryMatch;
    });
  }

  function renderTable() {
    const records = getFilteredScans();

    if (records.length === 0) {
      ui.scanTableBody.innerHTML = "";
      ui.emptyState.classList.remove("d-none");
      return;
    }

    ui.emptyState.classList.add("d-none");
    ui.scanTableBody.innerHTML = records
      .map(
        (scan, idx) => `
          <tr>
            <td>${idx + 1}</td>
            <td title="${escapeHtml(scan.value)}">${escapeHtml(scan.value)}</td>
            <td>
              <span class="badge ${scan.stockType === "IN" ? "text-bg-success" : "text-bg-warning"}">
                ${scan.stockType}
              </span>
            </td>
            <td>${formatTimestamp(scan.timestamp)}</td>
          </tr>
        `
      )
      .join("");
  }

  function renderAll() {
    renderStats();
    renderTable();
    updateLatestScan(state.scans[0]);
  }

  function escapeHtml(value) {
    return value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  async function resetAllData() {
    const confirmed = window.confirm("Reset all scanned records? This cannot be undone.");
    if (!confirmed) return;

    state.scans = [];
    state.lastSeenByCode.clear();
    saveScansToStorage();
    renderAll();
  }

  function exportToCsv() {
    if (!state.scans.length) {
      alert("No data available to export.");
      return;
    }

    const headers = ["QR Code Value", "Stock Type", "Scan Timestamp"];
    const rows = state.scans.map((scan) => [scan.value, scan.stockType, formatTimestamp(scan.timestamp)]);
    const csv = [headers, ...rows]
      .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(","))
      .join("\n");

    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    link.href = url;
    link.download = `warehouse-scan-export-${stamp}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  function triggerSuccessFeedback() {
    playSuccessBeep();
    ui.successPulse.classList.remove("show");
    void ui.successPulse.offsetWidth;
    ui.successPulse.classList.add("show");
    setTimeout(() => ui.successPulse.classList.remove("show"), 650);
  }

  function playSuccessBeep() {
    const context = state.audioContext;
    if (!context || context.state !== "running") return;
    const oscillator = context.createOscillator();
    const gain = context.createGain();

    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(980, context.currentTime);
    gain.gain.setValueAtTime(0.001, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.2, context.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.14);

    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.14);
  }

  async function ensureAudioReady() {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    if (!state.audioContext) {
      state.audioContext = new AudioContextClass();
    }
    if (state.audioContext.state === "suspended") {
      await state.audioContext.resume();
    }
  }

  function updateNetworkBadge() {
    const online = navigator.onLine;
    ui.networkBadge.className = online ? "badge text-bg-success px-3 py-2" : "badge text-bg-danger px-3 py-2";
    ui.networkBadge.textContent = online ? "Online" : "Offline";
  }

  document.addEventListener("DOMContentLoaded", init);
})();
