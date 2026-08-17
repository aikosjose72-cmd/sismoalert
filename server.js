/**
 * GNSS Proxy — Estación Sísmica
 * ---------------------------------------------------------------
 * Este servidor NO genera ni inventa datos. Su único trabajo es:
 *   1. Descargar el archivo público de velocidades GNSS "MIDAS" del
 *      Nevada Geodetic Laboratory (NGL, Universidad de Nevada, Reno):
 *          https://geodesy.unr.edu/velocities/midas.IGS14.txt
 *      Ese archivo contiene, para ~20,000+ estaciones GPS/GNSS en el
 *      mundo, la velocidad horizontal/vertical de la corteza en ese
 *      punto (m/año), calculada con el método robusto MIDAS
 *      (Blewitt, Kreemer, Hammond & Gazeaux, 2016, JGR).
 *   2. Cachear ese archivo en memoria (es grande y NGL pide no
 *      descargarlo repetidamente — es infraestructura académica
 *      gratuita, hay que ser buen ciudadano de red).
 *   3. Exponer un endpoint propio con CORS abierto, filtrando por
 *      caja delimitadora (bbox), para que un navegador pueda
 *      consultarlo sin toparse con la falta de CORS del servidor
 *      original de NGL.
 *
 * Formato del archivo (confirmado contra el README oficial de NGL,
 * https://geodesy.unr.edu/velocities/midas.readme.txt):
 *   col 1  (idx 0)  ID de estación (4 caracteres)
 *   col 2  (idx 1)  etiqueta de versión MIDAS
 *   col 3  (idx 2)  primera época (año decimal)
 *   col 4  (idx 3)  última época (año decimal)
 *   col 5  (idx 4)  duración de la serie (años)
 *   col 6  (idx 5)  número de épocas totales
 *   col 7  (idx 6)  número de épocas buenas
 *   col 8  (idx 7)  número de pares de velocidad usados
 *   col 9-11 (idx 8,9,10)  velocidad este, norte, vertical (m/año)
 *   col 12-14 (idx 11,12,13) incertidumbre de esas velocidades (m/año)
 *   col 15-17 (idx 14,15,16) offset este/norte/vertical en la primera época (m)
 *   col 18-20 (idx 17,18,19) fracción de outliers este/norte/vertical
 *   col 21-23 (idx 20,21,22) desviación estándar de pares de velocidad
 *   col 24 (idx 23) número de "steps" (saltos/discontinuidades) detectados
 *   col 25-27 (idx 24,25,26) latitud (deg), longitud (deg), altura (m)
 *
 * IMPORTANTE — verifica esto antes de confiar en los números:
 * Usa GET /api/gnss/raw-sample para ver las primeras líneas crudas
 * del archivo y confirmar visualmente que el mapeo de columnas de
 * arriba sigue siendo válido (NGL puede cambiar el formato).
 */

const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;
const MIDAS_URL = 'https://geodesy.unr.edu/velocities/midas.IGS14.txt';
const CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12 horas — MIDAS se actualiza semanalmente, no hace falta más seguido
const MAX_STATIONS_DEFAULT = 8;

// ---------------------------------------------------------------
// CORS: abierto por defecto para que cualquier página pueda usarlo.
// Si vas a exponer esto públicamente en producción, restringe esto
// a tu dominio real vía la variable de entorno ALLOWED_ORIGIN.
// ---------------------------------------------------------------
const allowedOrigin = process.env.ALLOWED_ORIGIN || '*';
app.use(cors({ origin: allowedOrigin }));

// Sé buen vecino de red: limita cuántas veces se puede pegar a este proxy.
// Esto protege tanto a este servidor como, indirectamente, a NGL.
app.use(rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas solicitudes. Espera un minuto.' }
}));

// ---------------------------------------------------------------
// Caché en memoria del catálogo completo de estaciones MIDAS
// ---------------------------------------------------------------
let stationCache = { data: null, fetchedAt: 0, rawSample: [] };

function parseMidasLine(line){
  const f = line.trim().split(/\s+/);
  if (f.length < 27) return null;
  const lat = parseFloat(f[24]);
  const lon = parseFloat(f[25]);
  const eastVel = parseFloat(f[8]);   // m/año
  const northVel = parseFloat(f[9]);  // m/año
  const durationYears = parseFloat(f[4]);
  if ([lat, lon, eastVel, northVel].some(v => Number.isNaN(v))) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return {
    id: f[0],
    lat, lon,
    durationYears,
    eastVelMmYr: eastVel * 1000,
    northVelMmYr: northVel * 1000,
    horizontalVelMmYr: Math.sqrt(eastVel*eastVel + northVel*northVel) * 1000
  };
}

async function loadStations(force=false){
  const isFresh = stationCache.data && (Date.now() - stationCache.fetchedAt) < CACHE_TTL_MS;
  if (isFresh && !force) return stationCache.data;

  const res = await fetch(MIDAS_URL);
  if (!res.ok) throw new Error('NGL respondió ' + res.status);
  const text = await res.text();
  const lines = text.split('\n').filter(l => l.trim().length > 0);

  stationCache.rawSample = lines.slice(0, 5);

  const stations = [];
  for (const line of lines){
    const parsed = parseMidasLine(line);
    if (parsed) stations.push(parsed);
  }
  stationCache.data = stations;
  stationCache.fetchedAt = Date.now();
  console.log(`[gnss-proxy] Catálogo MIDAS recargado: ${stations.length} estaciones válidas de ${lines.length} líneas`);
  return stations;
}

function haversineKm(lat1, lon1, lat2, lon2){
  const R = 6371;
  const dLat = (lat2-lat1) * Math.PI/180;
  const dLon = (lon2-lon1) * Math.PI/180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// ---------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    cache_loaded: !!stationCache.data,
    cache_size: stationCache.data ? stationCache.data.length : 0,
    cache_age_minutes: stationCache.data ? Math.round((Date.now()-stationCache.fetchedAt)/60000) : null
  });
});

// Útil para verificar manualmente que el mapeo de columnas sigue siendo correcto
app.get('/api/gnss/raw-sample', async (req, res) => {
  try{
    await loadStations();
    res.json({
      note: 'Primeras líneas crudas del archivo MIDAS de NGL, para verificar el mapeo de columnas contra el README.',
      readme: 'https://geodesy.unr.edu/velocities/midas.readme.txt',
      lines: stationCache.rawSample
    });
  }catch(e){
    res.status(502).json({ error: 'No se pudo descargar el catálogo de NGL', detail: e.message });
  }
});

app.get('/api/gnss', async (req, res) => {
  const { minlat, maxlat, minlon, maxlon } = req.query;
  const maxStations = Math.min(parseInt(req.query.maxStations) || MAX_STATIONS_DEFAULT, 20);

  if ([minlat, maxlat, minlon, maxlon].some(v => v === undefined)){
    return res.status(400).json({ error: 'Faltan parámetros: minlat, maxlat, minlon, maxlon son requeridos' });
  }
  const bbox = [parseFloat(minlat), parseFloat(minlon), parseFloat(maxlat), parseFloat(maxlon)];
  if (bbox.some(Number.isNaN)){
    return res.status(400).json({ error: 'Parámetros de bbox inválidos' });
  }

  try{
    const stations = await loadStations();
    const centerLat = (bbox[0]+bbox[2])/2, centerLon = (bbox[1]+bbox[3])/2;

    const inRegion = stations
      .filter(s => s.lat >= bbox[0] && s.lat <= bbox[2] && s.lon >= bbox[1] && s.lon <= bbox[3])
      .filter(s => s.durationYears >= 1) // MIDAS ya exige esto, pero por claridad
      .map(s => ({ ...s, distanceKm: haversineKm(centerLat, centerLon, s.lat, s.lon) }))
      .sort((a,b) => a.distanceKm - b.distanceKm)
      .slice(0, maxStations);

    if (inRegion.length === 0){
      return res.json({
        source: 'Nevada Geodetic Laboratory (MIDAS, geodesy.unr.edu)',
        bbox, station_count: 0,
        region_horizontal_velocity_mm_yr: null,
        stations: [],
        note: 'No hay estaciones GNSS de NGL dentro de esta caja delimitadora.'
      });
    }

    const avgVel = inRegion.reduce((s,st) => s + st.horizontalVelMmYr, 0) / inRegion.length;
    const maxVel = Math.max(...inRegion.map(s => s.horizontalVelMmYr));

    res.json({
      source: 'Nevada Geodetic Laboratory (MIDAS, geodesy.unr.edu)',
      citation: 'Blewitt, Kreemer, Hammond & Gazeaux (2016), JGR, doi:10.1002/2015JB012552',
      bbox, station_count: inRegion.length,
      region_horizontal_velocity_mm_yr: Number(avgVel.toFixed(2)),
      region_max_horizontal_velocity_mm_yr: Number(maxVel.toFixed(2)),
      stations: inRegion.map(s => ({
        id: s.id, lat: s.lat, lon: s.lon,
        distance_km: Math.round(s.distanceKm),
        horizontal_vel_mm_yr: Number(s.horizontalVelMmYr.toFixed(2)),
        duration_years: Number(s.durationYears.toFixed(1))
      })),
      cache_age_minutes: Math.round((Date.now()-stationCache.fetchedAt)/60000),
      note: 'Velocidad horizontal de largo plazo (deformación intersísmica). No indica por sí sola cuándo ocurrirá un sismo.'
    });
  }catch(e){
    res.status(502).json({ error: 'No se pudo obtener el catálogo GNSS de NGL', detail: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`[gnss-proxy] escuchando en puerto ${PORT}`);
  loadStations().catch(e => console.error('[gnss-proxy] fallo la precarga inicial:', e.message));
});
