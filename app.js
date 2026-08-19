/**
 * SismoGranada • Frontend & PWA Application Logic
 * ===============================================
 * Integración en tiempo real con datos sísmicos del IGN y EMSC,
 * renderizado cartográfico con Leaflet, gestión de configuración
 * y persistencia en GitHub mediante GitHub REST API.
 */

// =============================================================================
// CONSTANTES Y CONFIGURACIÓN
// =============================================================================
const GRANADA_COORDS = [37.1773, -3.5986];

// Endpoints oficiales con proxies de alta disponibilidad
const EMSC_URL = "https://www.seismicportal.eu/fdsnws/event/1/query?format=json&lat=37.1773&lon=-3.5986&maxradius=3.5&minmag=1.0&limit=60";
const IGN_RSS_PROXY = "https://corsproxy.io/?url=" + encodeURIComponent("https://www.ign.es/ign/RssTools/sismologia.xml");
const USGS_URL = "https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&latitude=37.1773&longitude=-3.5986&maxradiuskm=350&minmagnitude=1.0";

// Estado global de la aplicación
const AppState = {
  quakes: [],
  config: {
    radio_km: 60,
    magnitud_min: 1.5,
    notificar_whatsapp: true
  },
  github: {
    owner: "LuiseN8400",
    repo: "sismo-granada",
    branch: "main",
    token: ""
  },
  configSha: null,
  filterOnlyRadius: true, // FILTRAR POR DEFECTO A GRANADA Y ALREDEDORES
  map: null,
  granadaCircle: null,
  quakeLayerGroup: null,
  activeTab: "tab-list" // Pestaña de lista por defecto
};

// =============================================================================
// CÁLCULO DE HAVERSINE Y UTILIDADES
// =============================================================================
function calcularHaversine(lat1, lon1, lat2, lon2) {
  const R = 6371.0; // Radio de la Tierra en km
  const dLat = (lat2 - lat1) * Math.PI / 180.0;
  const dLon = (lon2 - lon1) * Math.PI / 180.0;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180.0) * Math.cos(lat2 * Math.PI / 180.0) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return parseFloat((R * c).toFixed(1));
}

function parseSpanishDateToTimestamp(dateStr) {
  // Formato esperado: "19/08/2026 17:14:51" o ISO "2026-08-19T17:14:51Z"
  if (!dateStr) return 0;
  if (dateStr.includes("/")) {
    try {
      const [datePart, timePart] = dateStr.split(" ");
      const [day, month, year] = datePart.split("/").map(Number);
      const [hour, minute, second] = (timePart || "00:00:00").split(":").map(Number);
      return new Date(year, month - 1, day, hour, minute, second || 0).getTime();
    } catch (e) {
      return 0;
    }
  }
  const t = new Date(dateStr).getTime();
  return isNaN(t) ? 0 : t;
}

function formatPlaceName(rawPlace) {
  if (!rawPlace) return "Entorno de Granada";
  let p = rawPlace.trim();

  // Expansión de siglas de provincias y países
  p = p.replace(/\.GR\b/g, " (Granada)");
  p = p.replace(/\.AL\b/g, " (Almería)");
  p = p.replace(/\.MA\b/g, " (Málaga)");
  p = p.replace(/\.JA\b/g, " (Jaén)");
  p = p.replace(/\.CO\b/g, " (Córdoba)");
  p = p.replace(/\.SE\b/g, " (Sevilla)");
  p = p.replace(/\.CA\b/g, " (Cádiz)");
  p = p.replace(/\.H\b/g, " (Huelva)");
  p = p.replace(/\.MU\b/g, " (Murcia)");
  p = p.replace(/\.ARG\b/g, " (Argelia)");
  p = p.replace(/\.POR\b/g, " (Portugal)");
  p = p.replace(/\.MAR\b/g, " (Marruecos)");

  // Expansión de direcciones cardinales
  p = p.replace(/^NE\s+/i, "Noreste de ");
  p = p.replace(/^NW\s+/i, "Noroeste de ");
  p = p.replace(/^SE\s+/i, "Sureste de ");
  p = p.replace(/^SW\s+/i, "Suroeste de ");
  p = p.replace(/^NNE\s+/i, "Nor-noreste de ");
  p = p.replace(/^NNW\s+/i, "Nor-noroeste de ");
  p = p.replace(/^ENE\s+/i, "Este-noreste de ");
  p = p.replace(/^WNW\s+/i, "Oeste-noroeste de ");
  p = p.replace(/^ESE\s+/i, "Este-sureste de ");
  p = p.replace(/^WSW\s+/i, "Oeste-suroeste de ");
  p = p.replace(/^N\s+/i, "Norte de ");
  p = p.replace(/^S\s+/i, "Sur de ");
  p = p.replace(/^E\s+/i, "Este de ");
  p = p.replace(/^W\s+/i, "Oeste de ");

  return p;
}

// =============================================================================
// SISTEMA DE TOASTS
// =============================================================================
function showToast(message, type = "info", duration = 3000) {
  const container = document.getElementById("toastContainer");
  if (!container) return;

  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  
  const icon = type === "success" ? "✅" : type === "error" ? "❌" : "ℹ️";
  toast.innerHTML = `<span>${icon}</span><span>${message}</span>`;
  
  container.appendChild(toast);
  setTimeout(() => toast.classList.add("show"), 10);

  setTimeout(() => {
    toast.classList.remove("show");
    setTimeout(() => toast.remove(), 400);
  }, duration);
}

// =============================================================================
// INICIALIZACIÓN DEL MAPA LEAFLET
// =============================================================================
function initMap() {
  const mapElement = document.getElementById("map");
  if (!mapElement || AppState.map) return;

  AppState.map = L.map("map", {
    center: GRANADA_COORDS,
    zoom: 9,
    zoomControl: true
  });

  L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png", {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/">CARTO</a>',
    subdomains: 'abcd',
    maxZoom: 19
  }).addTo(AppState.map);

  // Marcador de Granada capital
  const granadaIcon = L.divIcon({
    className: "granada-marker",
    html: `<div style="background: #0a84ff; width: 14px; height: 14px; border-radius: 50%; border: 3px solid white; box-shadow: 0 0 10px #0a84ff;"></div>`,
    iconSize: [14, 14],
    iconAnchor: [7, 7]
  });

  L.marker(GRANADA_COORDS, { icon: granadaIcon })
    .addTo(AppState.map)
    .bindPopup(`<strong>📍 Granada Capital</strong><br>Centro de monitorización sísmica`);

  // Círculo del radio de cobertura
  AppState.granadaCircle = L.circle(GRANADA_COORDS, {
    color: "#0a84ff",
    fillColor: "#0a84ff",
    fillOpacity: 0.12,
    weight: 2,
    radius: AppState.config.radio_km * 1000
  }).addTo(AppState.map);

  AppState.quakeLayerGroup = L.layerGroup().addTo(AppState.map);
}

function updateGranadaRadiusCircle() {
  if (AppState.granadaCircle) {
    AppState.granadaCircle.setRadius(AppState.config.radio_km * 1000);
  }
}

// =============================================================================
// OBTENCIÓN Y PARSEO DE DATOS SÍSMICOS EN TIEMPO REAL
// =============================================================================
function parseIGNRSS(xmlText) {
  try {
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(xmlText, "text/xml");
    const items = xmlDoc.querySelectorAll("item");
    const events = [];

    items.forEach((item) => {
      const title = item.querySelector("title")?.textContent || "";
      const link = item.querySelector("link")?.textContent || "";
      const desc = item.querySelector("description")?.textContent || "";
      const guid = item.querySelector("guid")?.textContent || "";
      
      const latElem = item.getElementsByTagNameNS("http://www.w3.org/2003/01/geo/wgs84_pos#", "lat")[0] ||
                      item.querySelector("lat");
      const lonElem = item.getElementsByTagNameNS("http://www.w3.org/2003/01/geo/wgs84_pos#", "long")[0] ||
                      item.querySelector("long");

      if (!latElem || !lonElem) return;

      const lat = parseFloat(latElem.textContent.trim());
      const lon = parseFloat(lonElem.textContent.trim());
      const eventId = guid.includes("evid=") ? guid.split("evid=")[1] : (link.includes("evid=") ? link.split("evid=")[1] : `${lat}_${lon}`);

      let mag = 0.0;
      let place = "Zona de Granada";
      let fechaHora = title.replace("-Info.terremoto:", "").trim();
      let depth = 0;

      if (desc.includes("magnitud")) {
        const parts = desc.split("magnitud");
        if (parts[1]) mag = parseFloat(parts[1].split("en")[0].trim()) || 0.0;
      }
      if (desc.includes(" en ") && desc.includes("en la fecha")) {
        place = desc.split(" en ")[1].split("en la fecha")[0].trim();
      }
      if (desc.includes("en la fecha") && desc.includes("en la siguiente")) {
        fechaHora = desc.split("en la fecha")[1].split("en la siguiente")[0].trim();
      }
      if (desc.toLowerCase().includes("profundidad")) {
        const pMatch = desc.toLowerCase().match(/profundidad[:\s]+([\d\.]+)/);
        if (pMatch) depth = parseFloat(pMatch[1]);
      }

      const timestamp = parseSpanishDateToTimestamp(fechaHora);
      const dist = calcularHaversine(GRANADA_COORDS[0], GRANADA_COORDS[1], lat, lon);

      events.push({
        id: eventId,
        lat,
        lon,
        mag,
        depth: depth,
        place: formatPlaceName(place),
        rawPlace: place,
        fechaHora,
        timestamp,
        distancia: dist,
        link: link || `http://www.ign.es/web/ign/portal/sis-catalogo-terremotos/-/catalogo-terremotos/detailTerremoto?evid=${eventId}`
      });
    });

    return events;
  } catch (e) {
    console.warn("Error parseando IGN RSS:", e);
    return [];
  }
}

function parseEMSCGeoJSON(data) {
  try {
    const features = data.features || [];
    return features.map((feat) => {
      const props = feat.properties || {};
      const geom = feat.geometry || {};
      const coords = geom.coordinates || [];
      const lon = coords[0] || props.lon || 0;
      const lat = coords[1] || props.lat || 0;
      const depth = Math.abs(coords[2] || props.depth || 0);
      const mag = parseFloat(props.mag || 0);
      
      let place = props.flynn_region || "Andalucía";
      if (place === "SPAIN") place = "Entorno de Granada";

      let fechaHora = props.time || "";
      let timestamp = 0;
      if (fechaHora) {
        try {
          const d = new Date(fechaHora);
          timestamp = d.getTime();
          fechaHora = d.toLocaleDateString("es-ES", { day: '2-digit', month: '2-digit', year: 'numeric' }) + " " +
                      d.toLocaleTimeString("es-ES", { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        } catch (e) {}
      }

      const id = props.unid || props.source_id || feat.id || `${lat}_${lon}`;
      const dist = calcularHaversine(GRANADA_COORDS[0], GRANADA_COORDS[1], lat, lon);

      return {
        id,
        lat,
        lon,
        mag,
        depth: parseFloat(depth.toFixed(1)),
        place: formatPlaceName(place),
        rawPlace: place,
        fechaHora,
        timestamp,
        distancia: dist,
        link: `https://www.emsc-csem.org/Earthquake/earthquake.php?id=${feat.id || id}`
      };
    });
  } catch (e) {
    return [];
  }
}

async function cargarDatosSismicos() {
  const badge = document.getElementById("lastSyncTime");
  const filterBadge = document.getElementById("txtFilterRadiusBadge");
  if (filterBadge) filterBadge.textContent = AppState.config.radio_km;
  if (badge) badge.textContent = "Actualizando...";

  let ignEvents = [];
  let emscEvents = [];

  // Peticiones paralelas para máxima velocidad
  const [ignPromise, emscPromise] = [
    fetch(IGN_RSS_PROXY, { signal: AbortSignal.timeout(5000) })
      .then(r => r.ok ? r.text() : "")
      .then(txt => txt.includes("<item>") ? parseIGNRSS(txt) : [])
      .catch(() => []),
    fetch(EMSC_URL, { signal: AbortSignal.timeout(5000) })
      .then(r => r.ok ? r.json() : null)
      .then(json => json ? parseEMSCGeoJSON(json) : [])
      .catch(() => [])
  ];

  const results = await Promise.allSettled([ignPromise, emscPromise]);
  if (results[0].status === "fulfilled") ignEvents = results[0].value;
  if (results[1].status === "fulfilled") emscEvents = results[1].value;

  // Mapa de profundidades exactas de EMSC indexadas por cercanía espacial/temporal
  const depthMap = new Map();
  emscEvents.forEach(e => {
    const key = `${e.lat.toFixed(2)}_${e.lon.toFixed(2)}`;
    if (e.depth > 0) depthMap.set(key, e.depth);
  });

  let combined = [];

  if (ignEvents.length > 0) {
    // Si tenemos datos del IGN, enriquecer con profundidad exacta de EMSC si falta
    combined = ignEvents.map(ev => {
      const key = `${ev.lat.toFixed(2)}_${ev.lon.toFixed(2)}`;
      if ((!ev.depth || ev.depth === 0) && depthMap.has(key)) {
        ev.depth = depthMap.get(key);
      }
      return ev;
    });
  } else if (emscEvents.length > 0) {
    combined = emscEvents;
  }

  if (combined.length > 0) {
    // Ordenar estrictamente por fecha descendente (más nuevo arriba)
    combined.sort((a, b) => b.timestamp - a.timestamp);
    AppState.quakes = combined;
    actualizarUIConSismos();

    const now = new Date();
    const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    if (badge) badge.textContent = `Actualizado: ${timeStr}`;
    showToast(`Actualizados ${combined.length} sismos en tiempo real`, "success", 2000);
  } else {
    if (badge) badge.textContent = "Reintentando...";
  }
}

// =============================================================================
// ACTUALIZACIÓN DE UI Y MAPA
// =============================================================================
function getMagBadgeClass(mag) {
  if (mag < 2.5) return "mag-low";
  if (mag < 3.5) return "mag-mid";
  if (mag < 4.5) return "mag-high";
  return "mag-critical";
}

function getMagMarkerColor(mag) {
  if (mag < 2.5) return "#30d158";
  if (mag < 3.5) return "#ffd60a";
  if (mag < 4.5) return "#ff9f0a";
  return "#ff453a";
}

function actualizarUIConSismos() {
  const quakes = AppState.quakes;
  if (!quakes || quakes.length === 0) return;

  const enRadio = quakes.filter(q => q.distancia <= AppState.config.radio_km);
  const masCercano = [...quakes].sort((a, b) => a.distancia - b.distancia)[0];
  const maxMagGranada = enRadio.length > 0
    ? [...enRadio].sort((a, b) => b.mag - a.mag)[0]
    : [...quakes].sort((a, b) => b.mag - a.mag)[0];
  const ultimoGranada = enRadio.length > 0 ? enRadio[0] : quakes[0];

  // Actualizar KPI Cards
  document.getElementById("kpiLastMag").textContent = `M ${ultimoGranada.mag.toFixed(1)}`;
  document.getElementById("kpiLastPlace").textContent = ultimoGranada.place.replace(" (Granada)", "").substring(0, 18);
  document.getElementById("kpiInRadius").textContent = enRadio.length;
  document.getElementById("kpiRadiusSub").textContent = `<= ${AppState.config.radio_km} km`;
  document.getElementById("kpiMaxMag").textContent = `M ${maxMagGranada.mag.toFixed(1)}`;
  document.getElementById("kpiMaxSub").textContent = maxMagGranada.place.replace(" (Granada)", "").substring(0, 16);
  document.getElementById("kpiClosestDist").textContent = `${masCercano.distancia} km`;
  document.getElementById("quakeCountBadge").textContent = AppState.filterOnlyRadius ? enRadio.length : quakes.length;
  document.getElementById("txtActiveRadius").textContent = AppState.config.radio_km;

  // Actualizar Marcadores en el Mapa
  if (AppState.quakeLayerGroup) {
    AppState.quakeLayerGroup.clearLayers();

    quakes.forEach(q => {
      const color = getMagMarkerColor(q.mag);
      const radius = Math.max(6, Math.min(22, q.mag * 4.5));
      const inRadius = q.distancia <= AppState.config.radio_km;

      const marker = L.circleMarker([q.lat, q.lon], {
        radius: radius,
        fillColor: color,
        color: inRadius ? "#ffffff" : color,
        weight: inRadius ? 2.5 : 1,
        opacity: 1,
        fillOpacity: 0.85
      });

      const depthLabel = q.depth && q.depth > 0 ? `${q.depth} km` : "Superficial (< 5 km)";

      const popupContent = `
        <div style="min-width: 190px; font-family: -apple-system, sans-serif;">
          <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px;">
            <span style="background: ${color}; color: ${q.mag < 3.5 && q.mag >= 2.5 ? '#000' : '#fff'}; font-weight: 800; padding: 2px 8px; border-radius: 6px; font-size: 12px;">M ${q.mag.toFixed(1)}</span>
            <span style="font-size: 11px; color: #8e8e93; font-weight: 600;">${q.distancia} km a Granada</span>
          </div>
          <h4 style="margin: 0 0 4px 0; font-size: 14px; font-weight: 700; color: #fff;">${q.place}</h4>
          <p style="margin: 0; font-size: 11px; color: #aaa;">🕒 ${q.fechaHora}</p>
          <p style="margin: 2px 0 6px 0; font-size: 11px; color: #aaa;">⬇️ Profundidad: ${depthLabel}</p>
          <a href="${q.link}" target="_blank" rel="noopener" style="display: inline-block; font-size: 11px; color: #0a84ff; text-decoration: none; font-weight: 600;">Ver Ficha Técnica Oficial →</a>
        </div>
      `;

      marker.bindPopup(popupContent);
      AppState.quakeLayerGroup.addLayer(marker);
    });
  }

  // Renderizar Lista de Sismos
  renderizarListaSismos();
}

function renderizarListaSismos() {
  const container = document.getElementById("quakeListContainer");
  if (!container) return;

  const quakes = AppState.filterOnlyRadius
    ? AppState.quakes.filter(q => q.distancia <= AppState.config.radio_km)
    : AppState.quakes;

  if (quakes.length === 0) {
    container.innerHTML = `
      <div style="text-align: center; padding: 40px 16px; color: var(--text-secondary);">
        <p style="font-size: 15px; font-weight: 600; margin-bottom: 6px;">No hay sismos en tu radio configurado (${AppState.config.radio_km} km).</p>
        <p style="font-size: 13px;">Toca en "Todos" para ver sismos de toda la península o amplía el radio en Ajustes (⚙️).</p>
      </div>
    `;
    return;
  }

  container.innerHTML = quakes.map(q => {
    const badgeClass = getMagBadgeClass(q.mag);
    const inRadius = q.distancia <= AppState.config.radio_km;
    const depthLabel = q.depth && q.depth > 0 ? `${q.depth} km` : "Superficial (< 5 km)";

    return `
      <div class="quake-item" onclick="focusQuakeOnMap(${q.lat}, ${q.lon})">
        <div class="quake-mag-badge ${badgeClass}">
          <span class="mag-num">${q.mag.toFixed(1)}</span>
          <span class="mag-label">Mag</span>
        </div>
        <div class="quake-details">
          <div class="quake-place">${q.place}</div>
          <div class="quake-meta">
            <span class="meta-chip ${inRadius ? 'highlight' : ''}">📍 ${q.distancia} km a Granada</span>
            <span class="meta-chip">🕒 ${q.fechaHora}</span>
            <span class="meta-chip">⬇️ ${depthLabel}</span>
          </div>
        </div>
      </div>
    `;
  }).join("");
}

window.focusQuakeOnMap = function(lat, lon) {
  const mapBtn = document.querySelector('.segment-btn[data-tab="tab-map"]');
  if (mapBtn) mapBtn.click();
  if (AppState.map) {
    setTimeout(() => {
      AppState.map.invalidateSize();
      AppState.map.flyTo([lat, lon], 12, { animate: true, duration: 1.0 });
    }, 150);
  }
};

// =============================================================================
// GESTIÓN DE CONFIGURACIÓN Y GITHUB REST API
// =============================================================================
function loadGithubSettingsFromStorage() {
  try {
    const saved = localStorage.getItem("sismo_github_settings");
    if (saved) {
      AppState.github = JSON.parse(saved);
    } else {
      AppState.github = {
        owner: "LuiseN8400",
        repo: "sismo-granada",
        branch: "main",
        token: ""
      };
    }
    document.getElementById("ghOwner").value = AppState.github.owner || "LuiseN8400";
    document.getElementById("ghRepo").value = AppState.github.repo || "sismo-granada";
    document.getElementById("ghBranch").value = AppState.github.branch || "main";
    document.getElementById("ghToken").value = AppState.github.token || "";
  } catch (e) {
    console.error("Error al cargar settings:", e);
  }
  updateRepoLabels();
}

function saveGithubSettingsToStorage() {
  AppState.github = {
    owner: document.getElementById("ghOwner").value.trim() || "LuiseN8400",
    repo: document.getElementById("ghRepo").value.trim() || "sismo-granada",
    branch: document.getElementById("ghBranch").value.trim() || "main",
    token: document.getElementById("ghToken").value.trim()
  };

  localStorage.setItem("sismo_github_settings", JSON.stringify(AppState.github));
  updateRepoLabels();
  showToast("Credenciales de GitHub guardadas en el dispositivo.", "success");
  closeSettingsModal();
  loadConfigFromGitHub();
}

function updateRepoLabels() {
  const lblRepo = document.getElementById("lblRepoTarget");
  const lblBranch = document.getElementById("lblBranchTarget");
  if (lblRepo) {
    lblRepo.textContent = AppState.github.owner && AppState.github.repo
      ? `${AppState.github.owner}/${AppState.github.repo}`
      : "LuiseN8400/sismo-granada";
  }
  if (lblBranch) {
    lblBranch.textContent = AppState.github.branch || "main";
  }
}

async function loadConfigFromGitHub() {
  try {
    const localResp = await fetch("config.json?t=" + Date.now());
    if (localResp.ok) {
      const cfg = await localResp.json();
      applyConfigToUI(cfg);
    }
  } catch (e) {}

  if (!AppState.github.owner || !AppState.github.repo) return;

  const url = `https://api.github.com/repos/${AppState.github.owner}/${AppState.github.repo}/contents/config.json?ref=${AppState.github.branch}`;
  const headers = { "Accept": "application/vnd.github.v3+json" };
  if (AppState.github.token) {
    headers["Authorization"] = `token ${AppState.github.token}`;
  }

  try {
    const resp = await fetch(url, { headers });
    if (resp.ok) {
      const data = await resp.json();
      AppState.configSha = data.sha;
      document.getElementById("lblShaTarget").textContent = data.sha.substring(0, 8);
      
      const content = decodeURIComponent(escape(atob(data.content)));
      const cfg = JSON.parse(content);
      applyConfigToUI(cfg);
    }
  } catch (err) {}
}

function applyConfigToUI(cfg) {
  AppState.config.radio_km = parseFloat(cfg.radio_km || 60);
  AppState.config.magnitud_min = parseFloat(cfg.magnitud_min || 1.5);
  AppState.config.notificar_whatsapp = cfg.notificar_whatsapp !== undefined ? cfg.notificar_whatsapp : true;

  document.getElementById("rangeRadio").value = AppState.config.radio_km;
  document.getElementById("numRadio").value = AppState.config.radio_km;
  document.getElementById("valRadioBadge").textContent = `${AppState.config.radio_km} km`;

  document.getElementById("rangeMag").value = AppState.config.magnitud_min;
  document.getElementById("numMag").value = AppState.config.magnitud_min;
  document.getElementById("valMagBadge").textContent = `M ${AppState.config.magnitud_min.toFixed(1)}`;

  document.getElementById("chkWhatsApp").checked = AppState.config.notificar_whatsapp;

  const filterBadge = document.getElementById("txtFilterRadiusBadge");
  if (filterBadge) filterBadge.textContent = AppState.config.radio_km;

  updateGranadaRadiusCircle();
  if (AppState.quakes.length > 0) {
    actualizarUIConSismos();
  }
}

async function saveConfigToGitHub() {
  if (!AppState.github.owner || !AppState.github.repo || !AppState.github.token) {
    showToast("Por favor ingresa tu Personal Access Token (PAT) en Ajustes (⚙️).", "error");
    openSettingsModal();
    return;
  }

  const saveBtn = document.getElementById("btnSaveConfig");
  saveBtn.disabled = true;
  saveBtn.innerHTML = `<span>⏳ Guardando en GitHub...</span>`;

  const getUrl = `https://api.github.com/repos/${AppState.github.owner}/${AppState.github.repo}/contents/config.json?ref=${AppState.github.branch}`;
  let sha = AppState.configSha;
  
  try {
    const getResp = await fetch(getUrl, {
      headers: {
        "Authorization": `token ${AppState.github.token}`,
        "Accept": "application/vnd.github.v3+json"
      }
    });
    if (getResp.ok) {
      const getData = await getResp.json();
      sha = getData.sha;
    }
  } catch (e) {}

  const newConfig = {
    radio_km: parseFloat(document.getElementById("rangeRadio").value),
    magnitud_min: parseFloat(document.getElementById("rangeMag").value),
    notificar_whatsapp: document.getElementById("chkWhatsApp").checked
  };

  const jsonString = JSON.stringify(newConfig, null, 2);
  const base64Content = btoa(unescape(encodeURIComponent(jsonString)));

  const payload = {
    message: `chore(config): actualizar parámetros sísmicos vía SismoGranada PWA [skip ci]`,
    content: base64Content,
    branch: AppState.github.branch
  };

  if (sha) {
    payload.sha = sha;
  }

  const putUrl = `https://api.github.com/repos/${AppState.github.owner}/${AppState.github.repo}/contents/config.json`;

  try {
    const putResp = await fetch(putUrl, {
      method: "PUT",
      headers: {
        "Authorization": `token ${AppState.github.token}`,
        "Accept": "application/vnd.github.v3+json",
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    if (putResp.ok) {
      const putData = await putResp.json();
      AppState.configSha = putData.content?.sha || null;
      if (AppState.configSha) {
        document.getElementById("lblShaTarget").textContent = AppState.configSha.substring(0, 8);
      }
      applyConfigToUI(newConfig);
      showToast("¡Configuración guardada en GitHub con éxito!", "success", 4000);
    } else {
      const errData = await putResp.json();
      showToast(`Error al guardar en GitHub: ${errData.message || 'Código ' + putResp.status}`, "error");
    }
  } catch (err) {
    showToast("Error de conexión con GitHub REST API.", "error");
  } finally {
    saveBtn.disabled = false;
    saveBtn.innerHTML = `<span>💾 Guardar Configuración en GitHub</span>`;
  }
}

async function triggerWorkflowDispatch() {
  if (!AppState.github.owner || !AppState.github.repo || !AppState.github.token) {
    showToast("Configura tu PAT de GitHub en Ajustes (⚙️) para lanzar workflows.", "error");
    openSettingsModal();
    return;
  }

  const btn = document.getElementById("btnTriggerWorkflow");
  btn.disabled = true;
  btn.innerHTML = `<span>⏳ Lanzando acción...</span>`;

  const url = `https://api.github.com/repos/${AppState.github.owner}/${AppState.github.repo}/actions/workflows/terremotos.yml/dispatches`;

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `token ${AppState.github.token}`,
        "Accept": "application/vnd.github.v3+json",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        ref: AppState.github.branch
      })
    });

    if (resp.status === 204) {
      showToast("⚡ ¡GitHub Action iniciada! Comprobando y alertando...", "success");
    } else {
      const err = await resp.json();
      showToast(`No se pudo iniciar: ${err.message || 'Código ' + resp.status}`, "error");
    }
  } catch (e) {
    showToast("Error al invocar GitHub Actions API.", "error");
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<span>⚡ Comprobar Sismos Ahora (GitHub Action)</span>`;
  }
}

// =============================================================================
// MODAL DRAWER Y CONTROLADORES DE EVENTOS
// =============================================================================
function openSettingsModal() {
  document.getElementById("settingsModal").classList.add("active");
}

function closeSettingsModal() {
  document.getElementById("settingsModal").classList.remove("active");
}

function setupEventListeners() {
  // Tabs Navigation
  document.querySelectorAll(".segment-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".segment-btn").forEach(b => b.classList.remove("active"));
      document.querySelectorAll(".tab-view").forEach(v => v.classList.remove("active"));

      btn.classList.add("active");
      const targetTab = btn.getAttribute("data-tab");
      document.getElementById(targetTab).classList.add("active");
      AppState.activeTab = targetTab;

      if (targetTab === "tab-map" && AppState.map) {
        setTimeout(() => AppState.map.invalidateSize(), 150);
      }
    });
  });

  // Sliders e Inputs sincronizados
  const rangeRadio = document.getElementById("rangeRadio");
  const numRadio = document.getElementById("numRadio");
  const valRadioBadge = document.getElementById("valRadioBadge");

  rangeRadio.addEventListener("input", (e) => {
    numRadio.value = e.target.value;
    valRadioBadge.textContent = `${e.target.value} km`;
    AppState.config.radio_km = parseFloat(e.target.value);
    const filterBadge = document.getElementById("txtFilterRadiusBadge");
    if (filterBadge) filterBadge.textContent = e.target.value;
    updateGranadaRadiusCircle();
    if (AppState.quakes.length > 0) actualizarUIConSismos();
  });

  numRadio.addEventListener("change", (e) => {
    let val = Math.max(10, Math.min(200, parseFloat(e.target.value) || 60));
    rangeRadio.value = val;
    numRadio.value = val;
    valRadioBadge.textContent = `${val} km`;
    AppState.config.radio_km = val;
    const filterBadge = document.getElementById("txtFilterRadiusBadge");
    if (filterBadge) filterBadge.textContent = val;
    updateGranadaRadiusCircle();
    if (AppState.quakes.length > 0) actualizarUIConSismos();
  });

  const rangeMag = document.getElementById("rangeMag");
  const numMag = document.getElementById("numMag");
  const valMagBadge = document.getElementById("valMagBadge");

  rangeMag.addEventListener("input", (e) => {
    numMag.value = e.target.value;
    valMagBadge.textContent = `M ${parseFloat(e.target.value).toFixed(1)}`;
    AppState.config.magnitud_min = parseFloat(e.target.value);
  });

  numMag.addEventListener("change", (e) => {
    let val = Math.max(1.0, Math.min(5.0, parseFloat(e.target.value) || 1.5));
    rangeMag.value = val;
    numMag.value = val.toFixed(1);
    valMagBadge.textContent = `M ${val.toFixed(1)}`;
    AppState.config.magnitud_min = val;
  });

  // Filtros de Lista
  document.getElementById("btnFilterAll").addEventListener("click", function() {
    AppState.filterOnlyRadius = false;
    this.classList.add("active");
    document.getElementById("btnFilterRadius").classList.remove("active");
    renderizarListaSismos();
    document.getElementById("quakeCountBadge").textContent = AppState.quakes.length;
  });

  document.getElementById("btnFilterRadius").addEventListener("click", function() {
    AppState.filterOnlyRadius = true;
    this.classList.add("active");
    document.getElementById("btnFilterAll").classList.remove("active");
    renderizarListaSismos();
    const enRadio = AppState.quakes.filter(q => q.distancia <= AppState.config.radio_km);
    document.getElementById("quakeCountBadge").textContent = enRadio.length;
  });

  // Botones de Acción
  document.getElementById("btnRefresh").addEventListener("click", cargarDatosSismicos);
  document.getElementById("btnSaveConfig").addEventListener("click", saveConfigToGitHub);
  document.getElementById("btnTriggerWorkflow").addEventListener("click", triggerWorkflowDispatch);

  // Settings Modal
  document.getElementById("btnOpenSettings").addEventListener("click", openSettingsModal);
  document.getElementById("btnCloseSettings").addEventListener("click", closeSettingsModal);
  document.getElementById("btnSaveGithubSettings").addEventListener("click", saveGithubSettingsToStorage);
  
  document.getElementById("settingsModal").addEventListener("click", (e) => {
    if (e.target.id === "settingsModal") closeSettingsModal();
  });
}

// =============================================================================
// SERVICE WORKER REGISTRATION (PWA)
// =============================================================================
function registerServiceWorker() {
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("sw.js")
        .then(reg => console.log("Service Worker activo"))
        .catch(err => console.warn("Service worker warning:", err));
    });
  }
}

// =============================================================================
// BOOTSTRAP DE LA APLICACIÓN
// =============================================================================
document.addEventListener("DOMContentLoaded", () => {
  initMap();
  setupEventListeners();
  loadGithubSettingsFromStorage();
  loadConfigFromGitHub();
  cargarDatosSismicos();
  registerServiceWorker();

  // Auto-refresco cada 45 segundos en la PWA mientras esté abierta
  setInterval(cargarDatosSismicos, 45000);
});
