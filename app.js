/* app.js — FuelBook (Dexie local + optional Firebase Cloud Sync)
   Passt zu deiner index.html (IDs/Views/Buttons).
   Voraussetzungen im HTML: firebase-app-compat, firebase-auth-compat, firebase-firestore-compat, dexie, chart.js, styles.css
*/

// ═══════════════════════════════════════════════════════════════
// FIREBASE CONFIGURATION - TRAGE DEINE DATEN HIER EIN:
// ═══════════════════════════════════════════════════════════════

const firebaseConfig = {
  apiKey: "DEIN_API_KEY_HIER",
  authDomain: "DEIN_PROJECT_ID.firebaseapp.com",
  projectId: "DEIN_PROJECT_ID",
  storageBucket: "DEIN_PROJECT_ID.appspot.com",
  messagingSenderId: "DEINE_SENDER_ID",
  appId: "DEINE_APP_ID"
};

// Firestore Security Rules (kopiere in Firebase Console → Firestore → Rules):
/*
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{userId}/{document=**} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }
  }
}
*/

// ═══════════════════════════════════════════════════════════════
// APP STATE
// ═══════════════════════════════════════════════════════════════

let app = {
  user: null,
  currentCar: null,
  useCloud: false,
  firebase: null,
  theme: localStorage.getItem("theme") || "dark",
  chart: {
    priceChart: null
  }
};

// ═══════════════════════════════════════════════════════════════
// DB (IndexedDB via Dexie)
// ═══════════════════════════════════════════════════════════════

const db = new Dexie("fuelbook");
db.version(1).stores({
  cars: "id, userId, name, createdAt, updatedAt",
  fillups: "id, userId, carId, datetime, createdAt",
  settings: "userId"
});

// ═══════════════════════════════════════════════════════════════
// Firebase init (only if config is valid)
// ═══════════════════════════════════════════════════════════════

if (firebaseConfig.apiKey !== "DEIN_API_KEY_HIER") {
  try {
    firebase.initializeApp(firebaseConfig);
    app.firebase = firebase;
    console.log("✅ Firebase initialisiert");
  } catch (e) {
    console.warn("⚠️ Firebase init fehlgeschlagen:", e);
  }
}

// ═══════════════════════════════════════════════════════════════
// UTILS
// ═══════════════════════════════════════════════════════════════

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function parseNumber(v) {
  const n = Number(String(v ?? "").replace(",", "."));
  return Number.isFinite(n) ? n : NaN;
}

function formatNumber(num, decimals = 2) {
  if (!Number.isFinite(num)) return "–";
  return new Intl.NumberFormat("de-DE", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals
  }).format(num);
}

function formatCurrency(num) {
  if (!Number.isFinite(num)) return "–";
  return new Intl.NumberFormat("de-DE", {
    style: "currency",
    currency: "EUR"
  }).format(num);
}

function formatDate(date) {
  return new Intl.DateTimeFormat("de-DE", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(date));
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (m) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#039;"
  }[m]));
}

function showToast(message, type = "info") {
  const container = $("#toastContainer");
  if (!container) return;

  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.innerHTML =
    `<span style="font-size: 20px;">${type === "success" ? "✅" : type === "error" ? "❌" : type === "warning" ? "⚠️" : "ℹ️"}</span>
     <span>${escapeHtml(message)}</span>`;

  container.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

function setTheme(theme) {
  app.theme = theme;
  document.body.classList.toggle("light-theme", theme === "light");
  const icon = $("#themeIcon");
  if (icon) icon.textContent = theme === "light" ? "☀️" : "🌙";
  localStorage.setItem("theme", theme);

  // falls Chart aktiv: neu zeichnen (damit CSS-Farben passen)
  if (getActiveView() === "stats") {
    setTimeout(() => renderPriceChart().catch(() => {}), 50);
  }
}

function getActiveView() {
  const active = document.querySelector(".nav-item.active");
  return active ? active.dataset.view : null;
}

async function readFileAsDataURL(file) {
  return await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

// iOS / Safari: Eviction reduzieren (optional)
async function tryPersistStorage() {
  if (!navigator.storage || !navigator.storage.persist) return false;
  try {
    const persisted = await navigator.storage.persisted();
    if (persisted) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════
// DATA LAYER (Local + optional Cloud)
// ═══════════════════════════════════════════════════════════════

async function saveCar(carData) {
  carData.userId = app.user.uid;
  carData.updatedAt = new Date().toISOString();
  if (!carData.createdAt) carData.createdAt = new Date().toISOString();

  await db.cars.put(carData);

  if (app.useCloud && app.firebase) {
    try {
      await firebase.firestore()
        .collection("users").doc(app.user.uid)
        .collection("cars").doc(carData.id)
        .set(carData, { merge: true });
    } catch (e) {
      console.error("Cloud sync failed:", e);
      showToast("Cloud Sync fehlgeschlagen (Auto)", "warning");
    }
  }

  return carData;
}

async function getCars() {
  const cars = await db.cars.where("userId").equals(app.user.uid).toArray();
  return cars.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

async function deleteCar(carId) {
  // local
  await db.cars.delete(carId);
  await db.fillups.where("carId").equals(carId).delete();

  // cloud
  if (app.useCloud && app.firebase) {
    try {
      const firestore = firebase.firestore();
      await firestore.collection("users").doc(app.user.uid).collection("cars").doc(carId).delete();

      // associated fillups in cloud
      const fillupsRef = firestore.collection("users").doc(app.user.uid).collection("fillups");
      const snap = await fillupsRef.where("carId", "==", carId).get();
      if (!snap.empty) {
        const batch = firestore.batch();
        snap.docs.forEach(d => batch.delete(d.ref));
        await batch.commit();
      }
    } catch (e) {
      console.error("Cloud delete failed:", e);
      showToast("Cloud Delete fehlgeschlagen (Auto)", "warning");
    }
  }
}

async function saveFillup(fillupData) {
  fillupData.userId = app.user.uid;
  fillupData.createdAt = new Date().toISOString();

  await db.fillups.put(fillupData);

  if (app.useCloud && app.firebase) {
    try {
      await firebase.firestore()
        .collection("users").doc(app.user.uid)
        .collection("fillups").doc(fillupData.id)
        .set(fillupData, { merge: true });
    } catch (e) {
      console.error("Cloud sync failed:", e);
      showToast("Cloud Sync fehlgeschlagen (Tankung)", "warning");
    }
  }

  return fillupData;
}

async function getFillups(carId) {
  const fillups = await db.fillups.where("carId").equals(carId).toArray();
  return fillups.sort((a, b) => new Date(b.datetime) - new Date(a.datetime));
}

async function syncFromCloud() {
  if (!app.useCloud || !app.firebase) return;

  try {
    const userUid = app.user.uid;
    const firestore = firebase.firestore();

    const carsSnap = await firestore.collection("users").doc(userUid).collection("cars").get();
    for (const doc of carsSnap.docs) {
      await db.cars.put({ id: doc.id, ...doc.data() });
    }

    const fillupsSnap = await firestore.collection("users").doc(userUid).collection("fillups").get();
    for (const doc of fillupsSnap.docs) {
      await db.fillups.put({ id: doc.id, ...doc.data() });
    }

    showToast("Synchronisierung abgeschlossen", "success");
  } catch (e) {
    showToast("Sync fehlgeschlagen: " + e.message, "error");
  }
}

// ═══════════════════════════════════════════════════════════════
// AUTH
// ═══════════════════════════════════════════════════════════════

function initAuth() {
  const authForm = $("#authForm");
  const authEmail = $("#authEmail");
  const authPassword = $("#authPassword");
  const authPasswordConfirm = $("#authPasswordConfirm");
  const authBtnText = $("#authBtnText");
  const authError = $("#authError");
  const localOnlyBtn = $("#localOnlyBtn");
  const useCloudCheckbox = $("#useCloud");

  let authMode = "login";

  $$(".auth-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      $$(".auth-tab").forEach(t => t.classList.remove("active"));
      tab.classList.add("active");
      authMode = tab.dataset.mode;

      if (authMode === "register") {
        authPasswordConfirm.classList.remove("hidden");
        authBtnText.textContent = "Registrieren";
      } else {
        authPasswordConfirm.classList.add("hidden");
        authBtnText.textContent = "Anmelden";
      }

      authError.classList.add("hidden");
    });
  });

  authForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    authError.classList.add("hidden");

    const email = authEmail.value.trim();
    const password = authPassword.value;
    const useCloud = useCloudCheckbox.checked;

    if (!email || !password) {
      authError.textContent = "Bitte E-Mail und Passwort eingeben";
      authError.classList.remove("hidden");
      return;
    }

    if (authMode === "register" && password !== authPasswordConfirm.value) {
      authError.textContent = "Passwörter stimmen nicht überein";
      authError.classList.remove("hidden");
      return;
    }

    try {
      if (useCloud && app.firebase) {
        const auth = firebase.auth();
        let cred;

        if (authMode === "register") {
          cred = await auth.createUserWithEmailAndPassword(email, password);
        } else {
          cred = await auth.signInWithEmailAndPassword(email, password);
        }

        app.user = { uid: cred.user.uid, email };
        app.useCloud = true;
        await syncFromCloud();
      } else {
        // local-only account keyed by email (stable)
        app.user = { uid: btoa(email).replace(/=+$/,""), email };
        app.useCloud = false;
      }

      localStorage.setItem("lastUser", JSON.stringify(app.user));
      startApp();
    } catch (error) {
      authError.textContent = "Fehler: " + error.message;
      authError.classList.remove("hidden");
    }
  });

  localOnlyBtn.addEventListener("click", () => {
    app.user = { uid: "local_" + uid(), email: "lokal@fuelbook.app" };
    app.useCloud = false;
    localStorage.setItem("lastUser", JSON.stringify(app.user));
    startApp();
  });
}

function startApp() {
  $("#authScreen")?.classList.add("hidden");
  $("#mainApp")?.classList.remove("hidden");

  setTheme(app.theme);
  setupHeaderActions();
  setupNavigation();

  // initial car selection
  updateActiveCarBar().then(() => {
    navigateTo("dashboard");
  });
}

// ═══════════════════════════════════════════════════════════════
// HEADER + NAV
// ═══════════════════════════════════════════════════════════════

function setupHeaderActions() {
  $("#themeToggle")?.addEventListener("click", () => {
    setTheme(app.theme === "dark" ? "light" : "dark");
  });

  $("#syncBtn")?.addEventListener("click", async () => {
    if (!app.useCloud) {
      showToast("Cloud-Speicherung ist deaktiviert", "warning");
      return;
    }
    $("#syncIcon")?.classList.add("spin");
    await syncFromCloud();
    $("#syncIcon")?.classList.remove("spin");
    await updateActiveCarBar();
  });

  $("#logoutBtn")?.addEventListener("click", async () => {
    if (!confirm("Wirklich abmelden?")) return;

    try {
      if (app.firebase && firebase.auth().currentUser) {
        await firebase.auth().signOut();
      }
    } catch {}

    localStorage.removeItem("lastUser");
    location.reload();
  });

  // Optional: userBtn könnte später ein Account-Menü öffnen
  $("#userBtn")?.addEventListener("click", () => {
    showToast(app.user?.email ? `Angemeldet: ${app.user.email}` : "Nicht angemeldet", "info");
  });
}

function setupNavigation() {
  $$(".nav-item").forEach(item => {
    item.addEventListener("click", () => {
      navigateTo(item.dataset.view);
    });
  });
}

async function navigateTo(viewName) {
  $$(".nav-item").forEach(item => {
    item.classList.toggle("active", item.dataset.view === viewName);
  });

  const container = $("#viewContainer");
  if (!container) return;

  container.innerHTML = `<div class="fade-in">${await getViewContent(viewName)}</div>`;
  setupViewListeners(viewName);

  if (viewName === "stats") {
    setTimeout(() => renderPriceChart().catch(()=>{}), 80);
  }
}

// ═══════════════════════════════════════════════════════════════
// ACTIVE CAR BAR
// ═══════════════════════════════════════════════════════════════

async function updateActiveCarBar() {
  const cars = await getCars();

  // keep current if exists, else first
  if (app.currentCar?.id) {
    const found = cars.find(c => c.id === app.currentCar.id);
    app.currentCar = found || cars[0] || null;
  } else {
    app.currentCar = cars[0] || null;
  }

  const carThumb = $("#carThumb");
  const carName = $("#carName");
  const carMeta = $("#carMeta");
  const carAvgPrice = $("#carAvgPrice");

  if (!carThumb || !carName || !carMeta || !carAvgPrice) return;

  if (!app.currentCar) {
    carThumb.textContent = "🚗";
    carThumb.innerHTML = "🚗";
    carName.textContent = "Kein Auto ausgewählt";
    carMeta.textContent = "Wähle ein Auto aus";
    carAvgPrice.textContent = "--";
    return;
  }

  // Image
  if (app.currentCar.imageData) {
    carThumb.innerHTML = `<img src="${app.currentCar.imageData}" alt="${escapeHtml(app.currentCar.name)}">`;
  } else {
    carThumb.textContent = "🚗";
  }

  carName.textContent = app.currentCar.name;

  const avgCons = parseNumber(app.currentCar.avgConsumption);
  carMeta.textContent =
    `${app.currentCar.fuelType || "Kraftstoff"} · ${app.currentCar.tankCapacity || "--"}L Tank · ${Number.isFinite(avgCons) ? formatNumber(avgCons, 1) : "--"} L/100km`;

  const fillups = await getFillups(app.currentCar.id);
  if (fillups.length > 0) {
    const valid = fillups.filter(f => Number.isFinite(parseNumber(f.pricePerLiter)));
    if (valid.length) {
      const avg = valid.reduce((s, f) => s + parseNumber(f.pricePerLiter), 0) / valid.length;
      carAvgPrice.textContent = formatNumber(avg, 3);
      return;
    }
  }
  carAvgPrice.textContent = "--";
}

// ═══════════════════════════════════════════════════════════════
// VIEWS
// ═══════════════════════════════════════════════════════════════

async function getViewContent(viewName) {
  switch (viewName) {
    case "dashboard": return await renderDashboard();
    case "fillup": return await renderFillup();
    case "stats": return await renderStats();
    case "cars": return await renderCars();
    case "settings": return await renderSettings();
    default: return `<div class="card"><p>View nicht gefunden</p></div>`;
  }
}

async function renderDashboard() {
  if (!app.currentCar) {
    return `
      <div class="card text-center">
        <h2>👋 Willkommen bei FuelBook!</h2>
        <p class="subtitle">Erstelle dein erstes Auto, um zu starten.</p>
        <button class="btn btn-primary" onclick="navigateTo('cars')">🚗 Auto erstellen</button>
      </div>
    `;
  }

  const fillups = await getFillups(app.currentCar.id);
  const recentFillups = fillups.slice(0, 5);

  const totalSpent = fillups.reduce((sum, f) => sum + (parseNumber(f.totalPrice) || 0), 0);
  const totalLiters = fillups.reduce((sum, f) => sum + (parseNumber(f.liters) || 0), 0);
  const avgPrice = totalLiters > 0 ? totalSpent / totalLiters : NaN;

  return `
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-card-value">${fillups.length}</div>
        <div class="stat-card-label">Tankungen</div>
      </div>
      <div class="stat-card">
        <div class="stat-card-value">${formatNumber(totalLiters, 0)}L</div>
        <div class="stat-card-label">Gesamt Liter</div>
      </div>
      <div class="stat-card">
        <div class="stat-card-value">${formatCurrency(totalSpent)}</div>
        <div class="stat-card-label">Gesamt Kosten</div>
      </div>
      <div class="stat-card">
        <div class="stat-card-value">${Number.isFinite(avgPrice) ? formatNumber(avgPrice, 3) + "€" : "--"}</div>
        <div class="stat-card-label">Ø Preis/L</div>
      </div>
    </div>

    <div class="card">
      <div class="card-header">
        <h3 class="card-title">🧾 Letzte Tankungen</h3>
        <button class="btn btn-primary" onclick="navigateTo('fillup')">+ Tanken</button>
      </div>

      ${recentFillups.length ? `
        <div style="display:flex; flex-direction:column; gap:12px;">
          ${recentFillups.map(f => `
            <div style="display:flex; align-items:center; gap:16px; padding:12px; background: var(--bg-secondary); border-radius: var(--radius-sm); border:1px solid var(--border);">
              <div style="font-size: 32px;">⛽</div>
              <div style="flex:1;">
                <div style="font-weight: 700;">${formatCurrency(f.totalPrice)} · ${formatNumber(f.liters, 2)}L</div>
                <div style="font-size: 14px; color: var(--text-muted);">
                  ${formatDate(f.datetime)} · ${formatNumber(f.pricePerLiter, 3)}€/L ${f.station ? "· " + escapeHtml(f.station) : ""}
                </div>
              </div>
              <div style="text-align:right;">
                <div style="font-weight: 800; color: var(--accent);">${formatNumber(f.odometer, 0)} km</div>
              </div>
            </div>
          `).join("")}
        </div>
      ` : `<p class="text-muted text-center">Noch keine Tankungen vorhanden</p>`}
    </div>
  `;
}

async function renderFillup() {
  if (!app.currentCar) {
    return `
      <div class="card text-center">
        <p class="text-muted">Wähle zuerst ein Auto aus</p>
        <button class="btn btn-primary mt-2" onclick="navigateTo('cars')">Zu Autos</button>
      </div>
    `;
  }

  const now = new Date();
  const dateStr = now.toISOString().slice(0, 16);

  return `
    <div class="card">
      <h2 class="card-title mb-2">⛽ Tankung erfassen</h2>

      <form id="fillupForm" class="auth-form">
        <div class="form-group">
          <label class="form-label">Datum & Uhrzeit</label>
          <input type="datetime-local" class="form-input" id="fillupDate" value="${dateStr}" required>
        </div>

        <div style="display:grid; grid-template-columns:1fr 1fr; gap:16px;">
          <div class="form-group">
            <label class="form-label">Liter</label>
            <input type="number" step="0.01" class="form-input" id="fillupLiters" placeholder="z.B. 42.5" required>
          </div>
          <div class="form-group">
            <label class="form-label">Betrag (€)</label>
            <input type="number" step="0.01" class="form-input" id="fillupPrice" placeholder="z.B. 75.80" required>
          </div>
        </div>

        <div class="form-group">
          <label class="form-label">Kilometerstand</label>
          <input type="number" class="form-input" id="fillupOdometer" placeholder="z.B. 125400" required>
        </div>

        <div class="form-group">
          <label class="form-label">Tankstelle (optional)</label>
          <input type="text" class="form-input" id="fillupStation" placeholder="z.B. Aral, Shell...">
        </div>

        <div class="form-group">
          <label class="form-label">Notiz (optional)</label>
          <textarea class="form-textarea" id="fillupNote" placeholder="z.B. Vollgetankt, Autobahn..."></textarea>
        </div>

        <button type="submit" class="btn btn-primary" style="width:100%;">💾 Speichern</button>
      </form>
    </div>
  `;
}

async function renderStats() {
  if (!app.currentCar) {
    return `<div class="card text-center"><p class="text-muted">Wähle zuerst ein Auto aus</p></div>`;
  }

  const fillups = await getFillups(app.currentCar.id);
  if (fillups.length < 2) {
    return `<div class="card text-center"><p class="text-muted">Mindestens 2 Tankungen benötigt für Statistiken</p></div>`;
  }

  // Verbrauch aus Odo-Deltas (Tankung i nutzt Liter von i)
  const sorted = [...fillups].sort((a, b) => new Date(a.datetime) - new Date(b.datetime));
  let totalKm = 0;
  let totalLiters = 0;

  for (let i = 1; i < sorted.length; i++) {
    const km = (parseNumber(sorted[i].odometer) || 0) - (parseNumber(sorted[i - 1].odometer) || 0);
    if (km > 0) {
      totalKm += km;
      totalLiters += (parseNumber(sorted[i].liters) || 0);
    }
  }

  const avgConsumption = totalKm > 0 ? (totalLiters / totalKm) * 100 : NaN;

  const totalSpent = fillups.reduce((s, f) => s + (parseNumber(f.totalPrice) || 0), 0);
  const litersSum = fillups.reduce((s, f) => s + (parseNumber(f.liters) || 0), 0);
  const avgPrice = litersSum > 0 ? totalSpent / litersSum : NaN;

  return `
    <div class="card">
      <h2 class="card-title mb-2">📊 Statistiken</h2>

      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-card-value">${Number.isFinite(avgConsumption) ? formatNumber(avgConsumption, 2) : "--"}</div>
          <div class="stat-card-label">Ø L/100km</div>
        </div>
        <div class="stat-card">
          <div class="stat-card-value">${formatNumber(totalKm, 0)}</div>
          <div class="stat-card-label">Gefahrene km</div>
        </div>
        <div class="stat-card">
          <div class="stat-card-value">${formatNumber(litersSum, 0)}</div>
          <div class="stat-card-label">Gesamt Liter</div>
        </div>
        <div class="stat-card">
          <div class="stat-card-value">${Number.isFinite(avgPrice) ? formatNumber(avgPrice, 3) + "€" : "--"}</div>
          <div class="stat-card-label">Ø €/L</div>
        </div>
      </div>

      <div style="height: 300px; margin-top: 20px;">
        <canvas id="priceChart"></canvas>
      </div>
    </div>
  `;
}

async function renderCars() {
  const cars = await getCars();

  return `
    <div class="card">
      <div class="card-header">
        <h2 class="card-title">🚗 Meine Autos</h2>
        <button class="btn btn-primary" onclick="showCarForm()">+ Auto</button>
      </div>

      <div id="carsList" style="display:flex; flex-direction:column; gap:12px;">
        ${cars.length ? cars.map(car => `
          <div style="display:flex; align-items:center; gap:16px; padding:16px; background:var(--bg-secondary); border-radius:var(--radius-sm); border:1px solid var(--border);">
            <div style="width:64px; height:64px; border-radius:var(--radius-sm); background:var(--bg-card); display:flex; align-items:center; justify-content:center; font-size:32px; overflow:hidden;">
              ${car.imageData ? `<img src="${car.imageData}" style="width:100%; height:100%; object-fit:cover;">` : "🚗"}
            </div>
            <div style="flex:1;">
              <div style="font-weight:800; font-size:18px;">${escapeHtml(car.name)}</div>
              <div style="font-size:14px; color:var(--text-muted); margin-top:4px;">
                ${escapeHtml(car.fuelType || "Kraftstoff")} · ${car.tankCapacity || "--"}L Tank · ${formatNumber(car.avgConsumption || 0, 1)} L/100km
              </div>
            </div>
            <div style="display:flex; gap:8px;">
              <button class="icon-btn" onclick="setCurrentCar('${car.id}')" title="Aktivieren">✅</button>
              <button class="icon-btn" onclick="editCar('${car.id}')" title="Bearbeiten">✏️</button>
              <button class="icon-btn" onclick="deleteCar_UI('${car.id}')" title="Löschen" style="color: var(--danger);">🗑️</button>
            </div>
          </div>
        `).join("") : `<p class="text-muted text-center">Noch keine Autos vorhanden</p>`}
      </div>
    </div>

    <div id="carFormModal" class="hidden">
      <div class="card">
        <h3 class="card-title mb-2">Auto hinzufügen/bearbeiten</h3>

        <form id="carForm" class="auth-form">
          <input type="hidden" id="carId">

          <div class="form-group">
            <label class="form-label">Name</label>
            <input type="text" class="form-input" id="carName" placeholder="z.B. VW Golf 1.4 TSI" required>
          </div>

          <div style="display:grid; grid-template-columns:1fr 1fr; gap:16px;">
            <div class="form-group">
              <label class="form-label">Kraftstoff</label>
              <select class="form-select" id="carFuelType">
                <option value="Benzin">Benzin</option>
                <option value="Diesel">Diesel</option>
                <option value="E10">E10</option>
                <option value="Elektro">Elektro</option>
              </select>
            </div>

            <div class="form-group">
              <label class="form-label">Tank (L)</label>
              <input type="number" class="form-input" id="carTank" placeholder="z.B. 50">
            </div>
          </div>

          <div class="form-group">
            <label class="form-label">Ø Verbrauch (L/100km)</label>
            <input type="number" step="0.1" class="form-input" id="carConsumption" placeholder="z.B. 6.5">
          </div>

          <div class="form-group">
            <label class="form-label">Foto (optional)</label>
            <input type="file" class="form-input" id="carImage" accept="image/*">
          </div>

          <div style="display:flex; gap:12px;">
            <button type="submit" class="btn btn-primary" style="flex:1;">💾 Speichern</button>
            <button type="button" class="btn btn-secondary" onclick="hideCarForm()">Abbrechen</button>
          </div>
        </form>
      </div>
    </div>
  `;
}

async function renderSettings() {
  return `
    <div class="card">
      <h2 class="card-title mb-2">⚙️ Einstellungen</h2>

      <div class="form-group">
        <label class="form-label">Theme</label>
        <select class="form-select" id="themeSelect" onchange="setTheme(this.value)">
          <option value="dark" ${app.theme === "dark" ? "selected" : ""}>Dunkel</option>
          <option value="light" ${app.theme === "light" ? "selected" : ""}>Hell</option>
        </select>
      </div>

      <div class="form-group">
        <label class="form-label">Speicherung</label>
        <div style="padding:16px; background:var(--bg-secondary); border-radius:var(--radius-sm); border:1px solid var(--border);">
          <div style="font-weight:700; margin-bottom:8px;">
            ${app.useCloud ? "☁️ Cloud-Speicherung aktiv" : "💾 Lokale Speicherung"}
          </div>
          <div style="font-size:14px; color:var(--text-muted);">
            ${app.useCloud ? "Daten werden mit Firebase synchronisiert" : "Daten werden nur auf diesem Gerät gespeichert"}
          </div>
        </div>
      </div>

      <div class="form-group">
        <label class="form-label">Account</label>
        <div style="padding:16px; background:var(--bg-secondary); border-radius:var(--radius-sm); border:1px solid var(--border);">
          <div style="font-weight:700; margin-bottom:4px;">${escapeHtml(app.user.email)}</div>
          <div style="font-size:14px; color:var(--text-muted);">User ID: ${escapeHtml(app.user.uid)}</div>
        </div>
      </div>

      <div class="form-group">
        <button class="btn btn-secondary" style="width:100%;" onclick="exportData()">📥 Daten exportieren (JSON)</button>
      </div>

      <div class="form-group">
        <button class="btn btn-secondary" style="width:100%;" onclick="document.getElementById('importFile').click()">📤 Daten importieren (JSON)</button>
        <input type="file" id="importFile" accept=".json" style="display:none;" onchange="importData(event)">
      </div>

      <div class="form-group">
        <button class="btn" style="width:100%; background: var(--danger); color: white;" onclick="clearAllData()">🗑️ Alle Daten löschen</button>
      </div>
    </div>
  `;
}

// ═══════════════════════════════════════════════════════════════
// VIEW LISTENERS
// ═══════════════════════════════════════════════════════════════

function setupViewListeners(viewName) {
  if (viewName === "fillup") {
    const form = $("#fillupForm");
    if (form) {
      form.addEventListener("submit", async (e) => {
        e.preventDefault();

        const liters = parseNumber($("#fillupLiters").value);
        const price = parseNumber($("#fillupPrice").value);
        const odo = parseInt($("#fillupOdometer").value, 10);

        if (!(liters > 0) || !(price > 0) || !Number.isFinite(odo) || odo <= 0) {
          showToast("Bitte Liter/Betrag/Kilometerstand korrekt eingeben", "error");
          return;
        }

        const fillup = {
          id: uid(),
          carId: app.currentCar.id,
          datetime: new Date($("#fillupDate").value).toISOString(),
          liters: liters,
          totalPrice: price,
          pricePerLiter: price / liters,
          odometer: odo,
          station: ($("#fillupStation").value || "").trim() || null,
          note: ($("#fillupNote").value || "").trim() || null
        };

        await saveFillup(fillup);
        showToast("Tankung gespeichert", "success");
        await updateActiveCarBar();
        navigateTo("dashboard");
      });
    }
  }

  if (viewName === "cars") {
    const carForm = $("#carForm");
    if (carForm) {
      carForm.addEventListener("submit", async (e) => {
        e.preventDefault();

        const carId = $("#carId").value || uid();
        const name = ($("#carName").value || "").trim();
        if (!name) {
          showToast("Bitte einen Namen eingeben", "error");
          return;
        }

        const imageInput = $("#carImage");
        const existing = await db.cars.get(carId);
        let imageData = existing?.imageData || null;

        if (imageInput?.files?.[0]) {
          imageData = await readFileAsDataURL(imageInput.files[0]);
        }

        const car = {
          id: carId,
          name,
          fuelType: $("#carFuelType").value,
          tankCapacity: parseNumber($("#carTank").value) || null,
          avgConsumption: parseNumber($("#carConsumption").value) || null,
          imageData,
          createdAt: existing?.createdAt || new Date().toISOString()
        };

        await saveCar(car);
        showToast("Auto gespeichert", "success");

        // wenn noch kein aktives Auto: setze dieses
        if (!app.currentCar) app.currentCar = car;

        await updateActiveCarBar();
        hideCarForm();
        navigateTo("cars");
      });
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// GLOBAL UI ACTIONS (Cars)
// ═══════════════════════════════════════════════════════════════

window.showCarForm = function () {
  $("#carFormModal")?.classList.remove("hidden");
  $("#carId").value = "";
  $("#carName").value = "";
  $("#carFuelType").value = "Benzin";
  $("#carTank").value = "";
  $("#carConsumption").value = "";
  $("#carImage").value = "";
};

window.hideCarForm = function () {
  $("#carFormModal")?.classList.add("hidden");
};

window.editCar = async function (carId) {
  const car = await db.cars.get(carId);
  if (!car) return;

  window.showCarForm();
  $("#carId").value = car.id;
  $("#carName").value = car.name;
  $("#carFuelType").value = car.fuelType || "Benzin";
  $("#carTank").value = car.tankCapacity ?? "";
  $("#carConsumption").value = car.avgConsumption ?? "";
};

window.deleteCar_UI = async function (carId) {
  if (!confirm("Auto wirklich löschen? Alle Tankungen werden ebenfalls gelöscht.")) return;

  await deleteCar(carId);

  if (app.currentCar?.id === carId) {
    app.currentCar = null;
  }

  showToast("Auto gelöscht", "success");
  await updateActiveCarBar();
  navigateTo("cars");
};

window.setCurrentCar = async function (carId) {
  const car = await db.cars.get(carId);
  if (!car) return;

  app.currentCar = car;
  await updateActiveCarBar();
  showToast(`Aktiv: ${car.name}`, "success");
  navigateTo("dashboard");
};

// ═══════════════════════════════════════════════════════════════
// DATA IMPORT/EXPORT
// ═══════════════════════════════════════════════════════════════

window.exportData = async function () {
  const cars = await db.cars.where("userId").equals(app.user.uid).toArray();
  const fillups = await db.fillups.where("userId").equals(app.user.uid).toArray();

  const data = {
    version: 1,
    exportDate: new Date().toISOString(),
    user: app.user,
    cars,
    fillups
  };

  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = `fuelbook_backup_${new Date().toISOString().slice(0, 10)}.json`;
  a.click();

  URL.revokeObjectURL(url);
  showToast("Export erfolgreich", "success");
};

window.importData = async function (event) {
  const file = event.target.files?.[0];
  if (!file) return;

  try {
    const text = await file.text();
    const data = JSON.parse(text);

    if (!data.cars || !data.fillups) throw new Error("Ungültiges Backup-Format");
    if (!confirm("Import überschreibt alle lokalen Daten. Fortfahren?")) return;

    await db.cars.where("userId").equals(app.user.uid).delete();
    await db.fillups.where("userId").equals(app.user.uid).delete();

    for (const car of data.cars) {
      car.userId = app.user.uid;
      await db.cars.put(car);
    }
    for (const fillup of data.fillups) {
      fillup.userId = app.user.uid;
      await db.fillups.put(fillup);
    }

    app.currentCar = null;
    showToast("Import erfolgreich", "success");
    await updateActiveCarBar();
    navigateTo("dashboard");
  } catch (e) {
    showToast("Import fehlgeschlagen: " + e.message, "error");
  }

  event.target.value = "";
};

window.clearAllData = async function () {
  if (!confirm("WIRKLICH ALLE Daten löschen? Dies kann nicht rückgängig gemacht werden!")) return;
  if (!confirm("Letzte Warnung: Alle Autos und Tankungen werden gelöscht!")) return;

  await db.cars.where("userId").equals(app.user.uid).delete();
  await db.fillups.where("userId").equals(app.user.uid).delete();

  if (app.useCloud && app.firebase) {
    try {
      const firestore = firebase.firestore();
      const batch = firestore.batch();

      const carsRef = firestore.collection("users").doc(app.user.uid).collection("cars");
      const fillupsRef = firestore.collection("users").doc(app.user.uid).collection("fillups");

      const carsSnap = await carsRef.get();
      carsSnap.docs.forEach(doc => batch.delete(doc.ref));

      const fillupsSnap = await fillupsRef.get();
      fillupsSnap.docs.forEach(doc => batch.delete(doc.ref));

      await batch.commit();
    } catch (e) {
      console.error("Cloud deletion failed:", e);
    }
  }

  app.currentCar = null;
  showToast("Alle Daten gelöscht", "warning");
  await updateActiveCarBar();
  navigateTo("dashboard");
};

// ═══════════════════════════════════════════════════════════════
// CHART.JS RENDERING
// ═══════════════════════════════════════════════════════════════

async function renderPriceChart() {
  const canvas = $("#priceChart");
  if (!canvas) return;
  if (!window.Chart) {
    console.warn("Chart.js fehlt — CDN Script in HTML prüfen.");
    return;
  }

  const fillups = await getFillups(app.currentCar.id);
  const sorted = [...fillups].sort((a, b) => new Date(a.datetime) - new Date(b.datetime));

  const labels = sorted.map(f =>
    new Date(f.datetime).toLocaleDateString("de-DE", { month: "short", day: "numeric" })
  );
  const prices = sorted.map(f => parseNumber(f.pricePerLiter) || 0);

  // destroy old chart instance
  if (app.chart.priceChart) {
    try { app.chart.priceChart.destroy(); } catch {}
    app.chart.priceChart = null;
  }

  const root = getComputedStyle(document.documentElement);
  const accent = (root.getPropertyValue("--accent") || "#00e676").trim();
  const border = (root.getPropertyValue("--border") || "rgba(255,255,255,.12)").trim();
  const muted = (root.getPropertyValue("--text-muted") || "#9aa3b2").trim();

  app.chart.priceChart = new Chart(canvas, {
    type: "line",
    data: {
      labels,
      datasets: [{
        label: "Preis pro Liter (€)",
        data: prices,
        borderColor: accent,
        backgroundColor: "rgba(0, 230, 118, 0.12)",
        tension: 0.4,
        fill: true,
        pointRadius: 2
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        y: {
          beginAtZero: false,
          ticks: { color: muted },
          grid: { color: border }
        },
        x: {
          ticks: { color: muted },
          grid: { color: border }
        }
      }
    }
  });
}

// ═══════════════════════════════════════════════════════════════
// APP INIT
// ═══════════════════════════════════════════════════════════════

window.addEventListener("DOMContentLoaded", async () => {
  // Persist request (hilft iOS)
  await tryPersistStorage();

  // Restore user
  const savedUser = localStorage.getItem("lastUser");
  if (savedUser) {
    try {
      app.user = JSON.parse(savedUser);

      // If Firebase exists, verify auth state (optional)
      if (app.firebase) {
        try {
          firebase.auth().onAuthStateChanged(async (fbUser) => {
            if (fbUser && fbUser.uid === app.user.uid) {
              app.useCloud = true;
              await syncFromCloud();
            } else {
              app.useCloud = false;
            }
            startApp();
          });
          return; // startApp handled in callback
        } catch {
          // fallback below
        }
      }

      startApp();
    } catch (e) {
      console.error("Failed to restore session:", e);
      initAuth();
    }
  } else {
    initAuth();
  }
});

// expose minimal globals used by inline onclick in templates
window.navigateTo = navigateTo;
window.setTheme = setTheme;
