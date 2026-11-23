"use strict";

const $ = (id) => document.getElementById(id);
const JOURS = ["L", "M", "M", "J", "V", "S", "D"];
const JOURS_LONGS = ["lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"];
const REFRESH_MS = 30000;

const state = {
  status: null,
  config: { power: 3, setpoint: 21, auto: false },
  plages: [],
  dirty: false,
  busy: false,
  timer: null,
  tab: "home",
};

// ---------- API ----------

// Les requêtes partent vers le moteur Kotlin de l'app Android (pont « Android »),
// qui répond plus tard par window.__dpReply(id, statut, corps).
const pending = new Map();
let nextId = 1;

window.__dpReply = (id, status, body) => {
  const p = pending.get(id);
  if (!p) return;
  pending.delete(id);
  let data = {};
  try {
    data = JSON.parse(body);
  } catch {
    /* corps vide */
  }
  if (status >= 200 && status < 300) p.resolve(data);
  else p.reject(new Error(data.error || `Erreur ${status}`));
};

function api(path, options = {}) {
  return new Promise((resolve, reject) => {
    if (!window.Android) return reject(new Error("Cette interface s'utilise dans l'app Android."));
    const id = nextId++;
    pending.set(id, { resolve, reject });
    const body = options.body === undefined ? null : JSON.stringify(options.body);
    window.Android.call(id, options.method || "GET", path, body);
  });
}

let toastTimer;
function toast(message, bad = false) {
  const t = $("toast");
  t.textContent = message;
  t.classList.toggle("bad", bad);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), bad ? 6000 : 3500);
}

// ---------- Onglets ----------

document.querySelectorAll(".tabbar button").forEach((b) =>
  b.addEventListener("click", () => showTab(b.dataset.tab)),
);

function showTab(tab) {
  if (state.tab === "schedules" && tab !== "schedules" && state.dirty) {
    toast("Pense à valider tes horaires, sinon ils ne seront pas enregistrés.");
  }
  state.tab = tab;
  document.querySelectorAll(".tabbar button").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  for (const name of ["home", "schedules", "settings"]) $(`tab-${name}`).hidden = name !== tab;
  window.scrollTo(0, 0);
  if (tab === "home") startPolling();
  else stopPolling();
  if (tab === "settings") loadSettings();
}

// ---------- Accueil ----------

function startPolling() {
  stopPolling();
  refresh();
  state.timer = setInterval(() => document.visibilityState === "visible" && refresh(), REFRESH_MS);
}
function stopPolling() {
  clearInterval(state.timer);
  state.timer = null;
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && state.tab === "home") refresh();
});

let refreshing = false;
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  $("updated").textContent = "Lecture du poêle…";
  try {
    const s = await api("/api/status");
    state.status = s;
    state.config = s.config;
    renderHome();
  } catch (err) {
    $("updated").textContent = "Poêle injoignable";
    toast(err.message, true);
  } finally {
    refreshing = false;
  }
}

const ON_STATES = ["allumage", "chauffe", "nettoyage"];
const fmt = (n, digits = 0) => Number(n).toLocaleString("fr-FR", { maximumFractionDigits: digits, minimumFractionDigits: digits });
const time = (iso) => new Date(iso).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });

function renderHome() {
  const s = state.status;
  const on = s && ON_STATES.includes(s.etat);
  const alarm = s && s.errorCode !== 0;

  $("etat").textContent = s ? s.etatLabel : "…";
  $("room").textContent = s ? `${fmt(s.roomTemperature, 1)}°` : "--";
  $("hero").classList.toggle("is-off", !!s && !on && !alarm);
  $("hero").classList.toggle("is-alarm", !!alarm);

  const btn = $("onoff");
  btn.classList.toggle("is-on", !!on);
  if (!confirming) {
    btn.classList.remove("confirm");
    $("onoff-label").textContent = on ? "Arrêt" : s && s.etat === "extinction" ? "Extinction…" : "Marche";
  }

  const auto = !!state.config.auto;
  document.querySelectorAll("#power button").forEach((b) =>
    b.setAttribute("aria-checked", String(b.dataset.p === "auto" ? auto : !auto && Number(b.dataset.p) === state.config.power)),
  );
  const heating = s && s.etat === "chauffe";
  $("power-hint").textContent = auto
    ? heating
      ? `Auto : puissance ${s.powerSetting} en ce moment, selon la pièce.`
      : "Auto : la puissance suivra la pièce dès que le poêle chauffera."
    : heating
      ? ""
      : "Utilisée au prochain allumage.";
  $("setpoint").textContent = `${state.config.setpoint}°`;
  $("setpoint-hint").textContent = state.config.pendingSetpoint ? "Sera envoyée dès que le poêle sera en chauffe." : "";

  $("alarm").hidden = !alarm;
  if (alarm) $("alarm-text").textContent = `Alarme : ${s.errorLabel}`;

  renderData();
  if (s) $("updated").textContent = `Mis à jour à ${time(s.readAt)}`;
}

function renderData() {
  const s = state.status;
  const grid = $("data");
  grid.replaceChildren();
  if (!s) return;
  const e = s.extras || {};
  const cards = [
    ["Fumées", fmt(s.fumesTemperature), "°C"],
    ["Carte", e.pcbTemp !== undefined ? fmt(e.pcbTemp) : null, "°C"],
    ["Ventilateur", e.fanRpm !== undefined ? fmt(e.fanRpm) : null, "tr/min"],
    ["Puissance réelle", fmt(s.realPower), `/ ${s.powerSetting || "-"}`],
    // Poêle arrêté, pas de tirage : le pressostat est ouvert, c'est normal.
    ["Pressostat", e.pressureOk !== undefined ? (e.pressureOk ? "OK" : ON_STATES.includes(s.etat) ? "Défaut" : "Au repos") : null, ""],
    ["Heures totales", e.hoursTotal !== undefined ? fmt(e.hoursTotal) : null, "h"],
    ["Heures partielles", e.hoursPartial !== undefined ? fmt(e.hoursPartial) : null, "h"],
    ["Erreur", s.errorCode === 0 ? "Aucune" : `E${s.errorCode}`, ""],
  ];
  for (const [label, value, unit] of cards) {
    if (value === null) continue; // donnée non fournie par le boîtier
    const card = document.createElement("div");
    card.className = "stat";
    const l = document.createElement("p");
    l.className = "stat-label";
    l.textContent = label;
    const v = document.createElement("span");
    v.className = "stat-value";
    v.textContent = value;
    card.append(l, v);
    if (unit) {
      const u = document.createElement("span");
      u.className = "unit";
      u.textContent = unit;
      card.append(u);
    }
    grid.append(card);
  }
}

// Marche / arrêt : un second appui confirme, pour éviter un allumage par erreur.
let confirmTimer;
let confirming = false;
$("onoff").addEventListener("click", async () => {
  const btn = $("onoff");
  const s = state.status;
  if (!s || state.busy) return;
  const on = ON_STATES.includes(s.etat);
  if (!confirming) {
    confirming = true;
    btn.classList.add("confirm");
    $("onoff-label").textContent = on ? "Éteindre ?" : "Allumer ?";
    clearTimeout(confirmTimer);
    confirmTimer = setTimeout(() => {
      confirming = false;
      renderHome();
    }, 5000);
    return;
  }
  clearTimeout(confirmTimer);
  confirming = false;
  btn.classList.remove("confirm");
  state.busy = true;
  btn.disabled = true;
  $("onoff-label").textContent = "Envoi…";
  try {
    if (on) {
      await api("/api/off", { method: "POST" });
      toast("Extinction demandée.");
    } else {
      const r = await api("/api/on", { method: "POST" });
      const messages = {
        allumage: "Allumage lancé.",
        "deja-en-allumage": "Le poêle est déjà en train de s'allumer.",
        "deja-en-marche": "Le poêle chauffe déjà.",
      };
      toast(messages[r.result] || "Commande envoyée.");
    }
  } catch (err) {
    toast(err.message, true);
  } finally {
    state.busy = false;
    btn.disabled = false;
    setTimeout(refresh, 3000);
  }
});

document.querySelectorAll("#power button").forEach((b) =>
  b.addEventListener("click", async () => {
    const auto = b.dataset.p === "auto";
    const power = auto ? "auto" : Number(b.dataset.p);
    const before = { ...state.config };
    if (auto) state.config.auto = true;
    else Object.assign(state.config, { power, auto: false });
    renderHome();
    try {
      const r = await api("/api/power", { method: "POST", body: { power } });
      if (r.warning) toast(r.warning, true);
      else if (auto) toast(r.sent ? `Mode Auto : puissance ${r.power} envoyée.` : "Mode Auto activé.");
      else toast(r.sent ? `Puissance ${power} envoyée.` : `Puissance ${power} enregistrée pour le prochain allumage.`);
      if (auto && r.sent) setTimeout(refresh, 2000);
    } catch (err) {
      state.config = before;
      renderHome();
      toast(err.message, true);
    }
  }),
);

// Consigne : on attend que Kevin arrête d'appuyer avant d'envoyer.
let setpointTimer;
function bumpSetpoint(delta) {
  const next = Math.min(40, Math.max(5, state.config.setpoint + delta));
  if (next === state.config.setpoint) return;
  state.config.setpoint = next;
  $("setpoint").textContent = `${next}°`;
  clearTimeout(setpointTimer);
  setpointTimer = setTimeout(async () => {
    try {
      const r = await api("/api/setpoint", { method: "POST", body: { temperature: next } });
      state.config.pendingSetpoint = !r.sent;
      if (r.warning) toast(r.warning, true);
      else toast(r.sent ? `Consigne ${next}° envoyée.` : `Consigne ${next}° enregistrée.`);
      renderHome();
    } catch (err) {
      toast(err.message, true);
    }
  }, 1200);
}
$("sp-minus").addEventListener("click", () => bumpSetpoint(-1));
$("sp-plus").addEventListener("click", () => bumpSetpoint(1));

$("reset-alarm").addEventListener("click", async () => {
  try {
    await api("/api/reset-alarm", { method: "POST" });
    toast("Alarme réinitialisée.");
    setTimeout(refresh, 2000);
  } catch (err) {
    toast(err.message, true);
  }
});
$("refresh").addEventListener("click", refresh);

// ---------- Horaires ----------

async function loadPlages() {
  try {
    state.plages = await api("/api/schedules");
    setDirty(false);
    renderPlages();
  } catch (err) {
    toast(err.message, true);
  }
}

function setDirty(dirty) {
  state.dirty = dirty;
  $("save-plages").disabled = !dirty;
}

function renderPlages() {
  const list = $("plages");
  list.replaceChildren();
  state.plages.forEach((p) => list.append(plageCard(p)));
}

function plageCard(p) {
  const node = $("plage-tpl").content.firstElementChild.cloneNode(true);
  const changed = () => {
    node.classList.toggle("is-off", !p.actif);
    setDirty(true);
  };
  node.classList.toggle("is-off", !p.actif);

  const name = node.querySelector(".plage-name");
  name.value = p.nom;
  name.addEventListener("input", () => {
    p.nom = name.value;
    changed();
  });

  const on = node.querySelector(".plage-on");
  on.checked = p.actif;
  on.addEventListener("change", () => {
    p.actif = on.checked;
    changed();
  });

  const startInput = node.querySelector(".plage-start");
  const endInput = node.querySelector(".plage-end");
  startInput.value = p.debut;
  endInput.value = p.fin;
  startInput.addEventListener("change", () => {
    p.debut = startInput.value;
    changed();
  });
  endInput.addEventListener("change", () => {
    p.fin = endInput.value;
    changed();
  });

  const days = node.querySelector(".days");
  JOURS.forEach((letter, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = letter;
    b.setAttribute("aria-label", JOURS_LONGS[i]);
    b.setAttribute("aria-pressed", String(p.jours[i]));
    b.addEventListener("click", () => {
      p.jours[i] = !p.jours[i];
      b.setAttribute("aria-pressed", String(p.jours[i]));
      changed();
    });
    days.append(b);
  });

  node.querySelector(".plage-delete").addEventListener("click", () => {
    state.plages = state.plages.filter((x) => x !== p);
    renderPlages();
    setDirty(true);
  });
  return node;
}

$("add-plage").addEventListener("click", () => {
  if (state.plages.length >= 20) return toast("20 plages au maximum.", true);
  state.plages.push({
    id: `p${Date.now().toString(36)}`,
    nom: `Plage ${state.plages.length + 1}`,
    debut: "12:00",
    fin: "14:00",
    jours: Array(7).fill(true),
    actif: true,
  });
  renderPlages();
  setDirty(true);
});

$("save-plages").addEventListener("click", async () => {
  for (const p of state.plages) {
    if (!p.debut || !p.fin) return toast(`« ${p.nom} » : il manque une heure.`, true);
    if (p.debut === p.fin) return toast(`« ${p.nom} » : le début et la fin sont identiques.`, true);
    if (p.actif && !p.jours.some(Boolean)) return toast(`« ${p.nom} » : coche au moins un jour.`, true);
  }
  $("save-plages").disabled = true;
  try {
    state.plages = await api("/api/schedules", { method: "PUT", body: state.plages });
    setDirty(false);
    renderPlages();
    toast("Horaires enregistrés.");
  } catch (err) {
    setDirty(true);
    toast(err.message, true);
  }
});

window.addEventListener("beforeunload", (e) => {
  if (state.dirty) e.preventDefault();
});

// ---------- Réglages ----------

const EXTRA_NAMES = {
  pcbTemp: "Température de la carte",
  fanRpm: "Ventilateur",
  pressureOk: "Pressostat",
  hoursTotal: "Heures totales",
  hoursPartial: "Heures partielles",
};

function fillDevice(s) {
  $("s-host").value = s.relayHost;
  $("s-port").value = s.relayPort;
  $("s-code").value = s.deviceCode;
  $("save-device").disabled = true;
}

async function loadSettings() {
  try {
    const s = await api("/api/settings");
    if ($("save-device").disabled) fillDevice(s);
    $("s-hidden").textContent = s.unsupported.length ? s.unsupported.map((n) => EXTRA_NAMES[n] || n).join(", ") : "Aucune : tout est affiché.";
    const contact = state.status ? state.status.readAt : s.lastContact;
    $("s-contact").textContent = contact ? time(contact) : "--";
  } catch (err) {
    toast(err.message, true);
  }
}

["s-host", "s-port", "s-code"].forEach((id) => $(id).addEventListener("input", () => ($("save-device").disabled = false)));

$("device-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("save-device").disabled = true;
  try {
    const s = await api("/api/settings", {
      method: "PUT",
      body: { relayHost: $("s-host").value, relayPort: Number($("s-port").value), deviceCode: $("s-code").value },
    });
    fillDevice(s);
    toast("Boîtier enregistré.");
    loadSettings();
  } catch (err) {
    $("save-device").disabled = false;
    toast(err.message, true);
  }
});

$("redetect").addEventListener("click", async () => {
  try {
    await api("/api/redetect", { method: "POST" });
    toast("Les données seront re-testées à la prochaine lecture.");
    loadSettings();
  } catch (err) {
    toast(err.message, true);
  }
});

// ---------- Démarrage ----------

showTab("home");
loadPlages();
