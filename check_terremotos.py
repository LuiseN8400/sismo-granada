#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Motor de Monitorización y Alertas de Terremotos para Granada y Alrededores
========================================================================
Desarrollado para ejecución serverless (GitHub Actions / Cron / Local).
Consulta fuentes oficiales del Instituto Geográfico Nacional (IGN),
calcula distancias con fórmula de Haversine, gestiona caché de eventos
y envía alertas automáticas a WhatsApp vía CallMeBot.
"""

import os
import sys
import json
import math
import urllib.request
import urllib.parse
import xml.etree.ElementTree as ET
from datetime import datetime, timezone

# Asegurar codificación UTF-8 en consola independientemente del sistema operativo
if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass


def cargar_env_local() -> None:
    """Carga variables desde .env si existe en el directorio de trabajo."""
    env_path = os.path.join(os.path.dirname(__file__), ".env")
    if os.path.exists(env_path):
        try:
            with open(env_path, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if line and not line.startswith("#") and "=" in line:
                        k, v = line.split("=", 1)
                        k = k.strip()
                        v = v.strip().strip("'\"")
                        if k and k not in os.environ:
                            os.environ[k] = v
        except Exception as e:
            print(f"⚠️ Aviso al leer .env: {e}")


# ==============================================================================
# CONFIGURACIÓN Y CONSTANTES BASE
# ==============================================================================
cargar_env_local()

GRANADA_LAT = 37.1773
GRANADA_LON = -3.5986

CONFIG_FILE = "config.json"
CACHE_FILE = "seen_events.json"

# Endpoints oficiales del Instituto Geográfico Nacional (IGN)
IGN_GEOJSON_URL = "https://www.ign.es/resources/sismologia/tproximos/prox.json"
IGN_RSS_URL = "https://www.ign.es/ign/RssTools/sismologia.xml"

# Endpoint alternativo europeo EMSC (para redundancia en caso de contingencia sísmica)
EMSC_GEOJSON_URL = (
    "https://www.seismicportal.eu/fdsnws/event/1/query?"
    "format=json&lat=37.1773&lon=-3.5986&maxradius=3.0&minmag=1.0&limit=50"
)

HTTP_TIMEOUT = 12
USER_AGENT = "SismoGranada-Monitor/1.0 (+https://github.com)"


# ==============================================================================
# UTILIDADES MATEMÁTICAS Y GEODÉSICAS (HAVERSINE)
# ==============================================================================
def calcular_haversine(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """
    Calcula la distancia del círculo máximo entre dos puntos en la Tierra
    utilizando la fórmula de Haversine. Retorna la distancia en kilómetros (km).
    """
    r_tierra = 6371.0  # Radio medio de la Tierra en kilómetros

    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    delta_phi = math.radians(lat2 - lat1)
    delta_lambda = math.radians(lon2 - lon1)

    a = (
        math.sin(delta_phi / 2.0) ** 2
        + math.cos(phi1) * math.cos(phi2) * math.sin(delta_lambda / 2.0) ** 2
    )
    c = 2.0 * math.atan2(math.sqrt(a), math.sqrt(1.0 - a))

    return round(r_tierra * c, 2)


# ==============================================================================
# GESTIÓN DE CONFIGURACIÓN Y CACHÉ
# ==============================================================================
def cargar_configuracion() -> dict:
    """Carga config.json o establece valores por defecto si no existe."""
    default_config = {
        "radio_km": 60,
        "magnitud_min": 1.5,
        "frecuencia_minutos": 5,
        "notificar_whatsapp": True,
    }

    if not os.path.exists(CONFIG_FILE):
        print(f"⚠️ {CONFIG_FILE} no encontrado. Usando configuración por defecto.")
        return default_config

    try:
        with open(CONFIG_FILE, "r", encoding="utf-8") as f:
            cfg = json.load(f)
            return {
                "radio_km": float(cfg.get("radio_km", 60)),
                "magnitud_min": float(cfg.get("magnitud_min", 1.5)),
                "frecuencia_minutos": int(cfg.get("frecuencia_minutos", 5)),
                "notificar_whatsapp": bool(cfg.get("notificar_whatsapp", True)),
            }
    except Exception as e:
        print(f"❌ Error al leer {CONFIG_FILE}: {e}. Usando valores por defecto.")
        return default_config


def cargar_cache_eventos() -> tuple[set, dict]:
    """Carga los IDs ya procesados desde seen_events.json."""
    if not os.path.exists(CACHE_FILE):
        return set(), {"seen_ids": [], "last_check": None, "events_count": 0}

    try:
        with open(CACHE_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
            if isinstance(data, list):
                return set(data), {"seen_ids": data, "last_check": None, "events_count": len(data)}
            elif isinstance(data, dict):
                ids = set(data.get("seen_ids", []))
                return ids, data
    except Exception as e:
        print(f"⚠️ Error al leer {CACHE_FILE}: {e}. Se inicializará nueva caché.")

    return set(), {"seen_ids": [], "last_check": None, "events_count": 0}


def guardar_cache_eventos(seen_ids: set, raw_cache: dict) -> None:
    """Guarda los IDs vistos en seen_events.json manteniendo un tamaño razonable."""
    # Mantener como máximo los últimos 300 IDs para evitar crecimiento desmedido
    ids_list = list(seen_ids)[-300:]
    cache_data = {
        "seen_ids": ids_list,
        "last_check": datetime.now(timezone.utc).isoformat(),
        "events_count": len(ids_list),
    }

    try:
        with open(CACHE_FILE, "w", encoding="utf-8") as f:
            json.dump(cache_data, f, indent=2, ensure_ascii=False)
        print(f"💾 Caché actualizada exitosamente en {CACHE_FILE} ({len(ids_list)} eventos).")
    except Exception as e:
        print(f"❌ Error al guardar {CACHE_FILE}: {e}")


# ==============================================================================
# OBTENCIÓN Y PARSEO DE EVENTOS SÍSMICOS
# ==============================================================================
def hacer_peticion_http(url: str) -> str | None:
    """Realiza una petición HTTP GET segura con encabezados de usuario."""
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as response:
            if response.status == 200:
                return response.read().decode("utf-8", errors="replace")
    except Exception as e:
        print(f"ℹ️ Petición a {url} finalizada con aviso: {e}")
    return None


def obtener_sismos_ign_geojson() -> list[dict]:
    """Intenta obtener y parsear el feed GeoJSON de IGN."""
    content = hacer_peticion_http(IGN_GEOJSON_URL)
    if not content:
        return []

    eventos = []
    try:
        data = json.loads(content)
        features = data.get("features", [])
        for feat in features:
            props = feat.get("properties", {})
            geom = feat.get("geometry", {})
            coords = geom.get("coordinates", [])

            if len(coords) < 2:
                continue

            lon, lat = float(coords[0]), float(coords[1])
            depth = float(coords[2]) if len(coords) > 2 else float(props.get("depth", props.get("profundidad", 0.0)))
            event_id = str(feat.get("id") or props.get("evid") or props.get("event_id") or f"{lat}_{lon}")
            mag = float(props.get("mag") or props.get("magnitude") or 0.0)
            place = str(props.get("place") or props.get("municipio") or "Zona no especificada")
            fecha_hora = str(props.get("time") or props.get("fecha") or props.get("fecha_hora") or "Reciente")
            link = str(props.get("url") or props.get("link") or f"http://www.ign.es/web/ign/portal/sis-catalogo-terremotos/-/catalogo-terremotos/detailTerremoto?evid={event_id}")

            eventos.append({
                "id": event_id,
                "lat": lat,
                "lon": lon,
                "magnitud": mag,
                "profundidad_km": depth,
                "lugar": place,
                "fecha_hora": fecha_hora,
                "enlace": link,
                "fuente": "IGN (GeoJSON)"
            })
    except Exception as e:
        print(f"⚠️ Error al procesar GeoJSON de IGN: {e}")

    return eventos


def obtener_sismos_ign_rss() -> list[dict]:
    """Obtiene y parsea el feed oficial RSS de la Red Sísmica Nacional del IGN."""
    content = hacer_peticion_http(IGN_RSS_URL)
    if not content:
        return []

    eventos = []
    try:
        root = ET.fromstring(content)
        items = root.findall(".//item")

        for item in items:
            title = item.findtext("title", "").strip()
            link = item.findtext("link", "").strip()
            desc = item.findtext("description", "").strip()
            guid = item.findtext("guid", "").strip()

            # Namespaces para geo:lat y geo:long
            lat_elem = item.find("{http://www.w3.org/2003/01/geo/wgs84_pos#}lat")
            lon_elem = item.find("{http://www.w3.org/2003/01/geo/wgs84_pos#}long")

            if lat_elem is None or lon_elem is None:
                continue

            lat = float(lat_elem.text.strip())
            lon = float(lon_elem.text.strip())

            # Extraer event_id de evid en guid o link
            event_id = guid.split("evid=")[-1] if "evid=" in guid else link.split("evid=")[-1] if "evid=" in link else f"{lat}_{lon}_{title}"

            # Parsear texto de description:
            # "Se ha producido un terremoto de magnitud 3.1 en NE LAS GABIAS.GR en la fecha 19/08/2026 17:14:52 en la siguiente localización: 37.1392,-3.6586"
            mag = 0.0
            lugar = "Entorno de Granada / Sur Peninsular"
            fecha_hora = title.replace("-Info.terremoto:", "").strip()
            depth = 0.0

            if "magnitud" in desc:
                try:
                    part_mag = desc.split("magnitud")[1].split("en")[0].strip()
                    mag = float(part_mag)
                except Exception:
                    pass

            if " en " in desc and "en la fecha" in desc:
                try:
                    lugar = desc.split(" en ")[1].split("en la fecha")[0].strip()
                except Exception:
                    pass

            if "en la fecha" in desc and "en la siguiente" in desc:
                try:
                    fecha_hora = desc.split("en la fecha")[1].split("en la siguiente")[0].strip()
                except Exception:
                    pass

            if "profundidad" in desc.lower():
                try:
                    p_text = desc.lower().split("profundidad")[1].split("km")[0].strip().replace(":", "")
                    depth = float(p_text)
                except Exception:
                    pass

            eventos.append({
                "id": event_id,
                "lat": lat,
                "lon": lon,
                "magnitud": mag,
                "profundidad_km": depth,
                "lugar": lugar,
                "fecha_hora": fecha_hora,
                "enlace": link or f"http://www.ign.es/web/ign/portal/sis-catalogo-terremotos/-/catalogo-terremotos/detailTerremoto?evid={event_id}",
                "fuente": "IGN (RSS)"
            })
    except Exception as e:
        print(f"⚠️ Error al procesar RSS de IGN: {e}")

    return eventos


GRANADA_TOWNS = [
    {"name": "Granada Capital", "lat": 37.1773, "lon": -3.5986},
    {"name": "Armilla", "lat": 37.1415, "lon": -3.6285},
    {"name": "Churriana de la Vega", "lat": 37.1482, "lon": -3.6441},
    {"name": "Alhendín", "lat": 37.1086, "lon": -3.6457},
    {"name": "Las Gabias", "lat": 37.1353, "lon": -3.6687},
    {"name": "Ogíjares", "lat": 37.1197, "lon": -3.6083},
    {"name": "Gójar", "lat": 37.1044, "lon": -3.6006},
    {"name": "La Zubia", "lat": 37.1206, "lon": -3.5852},
    {"name": "Villa de Otura", "lat": 37.0944, "lon": -3.6333},
    {"name": "Cúllar Vega", "lat": 37.1531, "lon": -3.6708},
    {"name": "Vegas del Genil", "lat": 37.1714, "lon": -3.6744},
    {"name": "Santa Fe", "lat": 37.1894, "lon": -3.7183},
    {"name": "Atarfe", "lat": 37.2222, "lon": -3.6872},
    {"name": "Albolote", "lat": 37.2306, "lon": -3.6561},
    {"name": "Maracena", "lat": 37.2075, "lon": -3.6339},
    {"name": "Peligros", "lat": 37.2322, "lon": -3.6278},
    {"name": "Huétor Vega", "lat": 37.1458, "lon": -3.5786},
    {"name": "Cájar", "lat": 37.1344, "lon": -3.5708},
    {"name": "Monachil", "lat": 37.1319, "lon": -3.5392},
    {"name": "Dílar", "lat": 37.0750, "lon": -3.6014},
    {"name": "Padul", "lat": 37.0242, "lon": -3.6267},
    {"name": "Dúrcal", "lat": 36.9886, "lon": -3.5658}
]


def resolver_municipio_cercano(lat: float, lon: float, default_place: str = "") -> str:
    """Identifica el municipio más cercano en el entorno de Granada para coordenadas GPS."""
    closest = None
    min_d = 999999.0
    for t in GRANADA_TOWNS:
        d = calcular_haversine(lat, lon, t["lat"], t["lon"])
        if d < min_d:
            min_d = d
            closest = t

    if closest and min_d < 3.5:
        return f"{closest['name']} (Granada)"
    elif closest and min_d < 18.0:
        dlat = lat - closest["lat"]
        dlon = lon - closest["lon"]
        card = ""
        if dlat > 0.01: card += "Norte"
        elif dlat < -0.01: card += "Sur"
        if dlon > 0.01: card += ("este" if not card else "-este")
        elif dlon < -0.01: card += ("oeste" if not card else "-oeste")

        pref = f"Entorno {card} de " if card else "Cerca de "
        return f"{pref}{closest['name']} (Granada)"

    return default_place or "Provincia de Granada"


def obtener_sismos_emsc() -> list[dict]:
    """Consulta el feed EMSC que transmite datos directos de la Red Sísmica Nacional en tiempo real."""
    content = hacer_peticion_http(EMSC_GEOJSON_URL)
    if not content:
        return []

    eventos = []
    try:
        data = json.loads(content)
        for feat in data.get("features", []):
            props = feat.get("properties", {})
            geom = feat.get("geometry", {})
            coords = geom.get("coordinates", [])
            if len(coords) < 2:
                continue

            lat = float(coords[1])
            lon = float(coords[0])
            depth = abs(float(coords[2])) if len(coords) > 2 else float(props.get("depth", 0.0))
            mag = float(props.get("mag", 0.0))
            raw_time = str(props.get("time", ""))

            # Formatear fecha legible
            fecha_hora = raw_time
            if "T" in raw_time:
                try:
                    dt = datetime.fromisoformat(raw_time.replace("Z", "+00:00"))
                    fecha_hora = dt.strftime("%d/%m/%Y %H:%M:%S UTC")
                except Exception:
                    pass

            lugar = resolver_municipio_cercano(lat, lon, str(props.get("flynn_region", "Andalucía")))

            eventos.append({
                "id": str(props.get("unid") or feat.get("id") or f"{lat}_{lon}_{raw_time}"),
                "lat": lat,
                "lon": lon,
                "magnitud": mag,
                "profundidad_km": round(depth, 1),
                "lugar": lugar,
                "fecha_hora": fecha_hora,
                "enlace": f"https://www.emsc-csem.org/Earthquake/earthquake.php?id={feat.get('id') or props.get('unid')}",
                "fuente": "IGN / EMSC Red Sísmica"
            })
    except Exception as e:
        print(f"⚠️ Error al procesar EMSC: {e}")

    return eventos


def obtener_todos_los_sismos() -> list[dict]:
    """Combina todas las fuentes disponibles (IGN RSS + EMSC) garantizando cobertura completa de microseísmos."""
    eventos_map = {}

    # 1. Feed RSS del IGN
    sismos_ign = obtener_sismos_ign_rss()
    for s in sismos_ign:
        key = f"{round(s['lat'], 2)}_{round(s['lon'], 2)}"
        eventos_map[key] = s

    # 2. Feed EMSC en tiempo real (agrega todos los microseísmos M1.5 - M2.5)
    sismos_emsc = obtener_sismos_emsc()
    for s in sismos_emsc:
        key = f"{round(s['lat'], 2)}_{round(s['lon'], 2)}"
        if key not in eventos_map:
            eventos_map[key] = s
        else:
            # Si ya estaba de IGN, enriquecer con profundidad exacta de EMSC si no la tenía
            if not eventos_map[key].get("profundidad_km") and s.get("profundidad_km"):
                eventos_map[key]["profundidad_km"] = s["profundidad_km"]

    lista_total = list(eventos_map.values())
    print(f"✅ Obtenidos {len(lista_total)} eventos sísmicos unificados (IGN + EMSC).")
    return lista_total


# ==============================================================================
# ENVÍO DE ALERTAS POR WHATSAPP (CALLMEBOT)
# ==============================================================================
def formatear_mensaje_whatsapp(evento: dict, distancia_km: float) -> str:
    """Construye un mensaje limpio y bien estructurado con emojis para WhatsApp."""
    lugar = evento["lugar"].replace(".GR", " (Granada)").replace(".AL", " (Almería)").replace(".MA", " (Málaga)").replace(".JA", " (Jaén)")
    prof = f"{evento['profundidad_km']} km" if evento.get("profundidad_km") else "Superficial"
    
    # Determinar emoji de severidad
    mag = evento["magnitud"]
    if mag >= 4.0:
        severidad = "🚨🚨 *ALERTA SÍSMICA SEVERA*"
    elif mag >= 3.0:
        severidad = "⚠️ *ALERTA SÍSMICA MODERADA*"
    else:
        severidad = "🟢 *REGISTRO SÍSMICO DETECTADO*"

    msg = (
        f"{severidad}\n"
        f"📍 *Zona/Municipio:* {lugar}\n"
        f"💥 *Magnitud:* {mag:.1f} mbLg\n"
        f"📏 *Distancia a Granada:* {distancia_km:.1f} km\n"
        f"⬇️ *Profundidad:* {prof}\n"
        f"🕒 *Fecha/Hora:* {evento['fecha_hora']}\n"
        f"🌐 *Fuente:* {evento['fuente']}\n"
        f"🔗 *Info Oficial:* {evento['enlace']}"
    )
    return msg


def enviar_alerta_whatsapp(mensaje: str, phone: str, api_key: str) -> bool:
    """Envía la alerta por WhatsApp consumiendo la API de CallMeBot."""
    # Limpiar formato de teléfono (quitar +, espacios y guiones)
    phone_clean = phone.replace("+", "").replace(" ", "").replace("-", "").strip()
    mensaje_encoded = urllib.parse.quote(mensaje)
    
    endpoint = f"https://api.callmebot.com/whatsapp.php?phone={phone_clean}&text={mensaje_encoded}&apikey={api_key.strip()}"
    
    try:
        req = urllib.request.Request(endpoint, headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as response:
            resp_text = response.read().decode("utf-8", errors="replace")
            if response.status == 200:
                print(f"📱 Notificación WhatsApp enviada con éxito a +{phone_clean}.")
                return True
            else:
                print(f"⚠️ CallMeBot respondió con código {response.status}: {resp_text}")
    except Exception as e:
        print(f"❌ Error al conectar con CallMeBot WhatsApp API: {e}")

    return False


# ==============================================================================
# FUNCIÓN PRINCIPAL DE EJECUCIÓN
# ==============================================================================
def main() -> int:
    print("\n" + "=" * 65)
    print("🌍 MONITOR DE TERREMOTOS GRANADA - IGN REALTIME ENGINE")
    print(f"📍 Coordenadas de Referencia: Lat {GRANADA_LAT}, Lon {GRANADA_LON} (Granada)")
    print(f"🕒 Timestamp: {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}")
    print("=" * 65 + "\n")

    # 1. Cargar Configuración
    config = cargar_configuracion()
    radio_km = config["radio_km"]
    magnitud_min = config["magnitud_min"]
    notificar_whatsapp = config["notificar_whatsapp"]

    print(f"⚙️ Configuración activa:")
    print(f"   • Radio de Cobertura: <= {radio_km} km")
    print(f"   • Magnitud Mínima:   >= {magnitud_min}")
    print(f"   • Alertas WhatsApp:  {'Activadas ✅' if notificar_whatsapp else 'Desactivadas ⏸️'}\n")

    # 2. Cargar Caché de Eventos Vistos
    seen_ids, raw_cache = cargar_cache_eventos()
    print(f"📂 Caché cargada: {len(seen_ids)} eventos previamente registrados.\n")

    # 3. Obtener Datos Sísmicos
    eventos = obtener_todos_los_sismos()
    if not eventos:
        print("ℹ️ No hay eventos para procesar en este ciclo.")
        return 0

    # 4. Credenciales de WhatsApp
    phone_number = (
        os.environ.get("PHONE_NUMBER")
        or os.environ.get("WHATSAPP_PHONE")
        or os.environ.get("CALLMEBOT_PHONE", "")
    ).strip()
    callmebot_api_key = os.environ.get("CALLMEBOT_API_KEY", "").strip()

    alertas_enviadas = 0
    nuevos_eventos_registrados = 0

    print("🔍 Analizando sismos detectados:")
    for ev in eventos:
        ev_id = ev["id"]
        lat = ev["lat"]
        lon = ev["lon"]
        mag = ev["magnitud"]
        lugar = ev["lugar"]

        distancia = calcular_haversine(GRANADA_LAT, GRANADA_LON, lat, lon)

        # Criterios de filtrado
        cumple_radio = distancia <= radio_km
        cumple_magnitud = mag >= magnitud_min
        es_nuevo = ev_id not in seen_ids

        status_tag = "🆕 NUEVO" if es_nuevo else "👁️ YA VISTO"
        print(f"   [{status_tag}] M{mag:.1f} | {lugar[:25]:<25} | Dist: {distancia:5.1f}km | ID: {ev_id}")

        if es_nuevo:
            seen_ids.add(ev_id)
            nuevos_eventos_registrados += 1

            if cumple_radio and cumple_magnitud:
                print(f"   🎯 ¡EVENTO RELEVANTE DETECTADO! (M{mag:.1f} a {distancia:.1f} km de Granada)")
                
                if notificar_whatsapp:
                    if phone_number and callmebot_api_key:
                        mensaje = formatear_mensaje_whatsapp(ev, distancia)
                        if enviar_alerta_whatsapp(mensaje, phone_number, callmebot_api_key):
                            alertas_enviadas += 1
                    else:
                        print("   ⚠️ Notificación omitida: Variables PHONE_NUMBER y/o CALLMEBOT_API_KEY no definidas en el entorno.")
                else:
                    print("   ⏸️ Notificaciones desactivadas en config.json.")

    # 5. Persistir Caché si hubo nuevos eventos
    if nuevos_eventos_registrados > 0:
        guardar_cache_eventos(seen_ids, raw_cache)
    else:
        print("ℹ️ Sin nuevos eventos sísmicos en este ciclo.")

    print("\n" + "-" * 65)
    print(f"✨ Resumen de ejecución: {len(eventos)} sismos inspeccionados | {nuevos_eventos_registrados} nuevos | {alertas_enviadas} alertas enviadas.")
    print("-" * 65 + "\n")

    return 0


if __name__ == "__main__":
    sys.exit(main())
