# GNSS Proxy — Estación Sísmica

Backend mínimo que resuelve el problema de CORS para consumir datos GNSS
reales del **Nevada Geodetic Laboratory (NGL)** desde el dashboard en el
navegador. No genera datos: sólo descarga, cachea y filtra por zona un
archivo público real.

## De dónde vienen los datos

`https://geodesy.unr.edu/velocities/midas.IGS14.txt` — velocidades GNSS de
~20,000+ estaciones GPS/GNSS en el mundo, calculadas con el método robusto
**MIDAS** (Blewitt, Kreemer, Hammond & Gazeaux, 2016, *Journal of
Geophysical Research*, doi:10.1002/2015JB012552). Es la misma fuente que
usan papers publicados y servicios como el European Ground Motion Service
para validación.

La velocidad horizontal reportada (mm/año) refleja **deformación
intersísmica de largo plazo** — qué tan rápido se está moviendo/deformando
la corteza en ese punto. Zonas de subducción activa suelen mostrar decenas
de mm/año; zonas intraplaca, unos pocos mm/año o menos. **Esto no dice
cuándo** ocurrirá un sismo — es una de varias señales del modelo
experimental del dashboard, no una predicción por sí sola.

## Por qué hace falta un backend y no basta con `fetch()` desde el navegador

El servidor de NGL es infraestructura académica gratuita y no envía
cabeceras CORS, así que un navegador bloquea la petición directa aunque el
archivo sea público. Este proxy la hace del lado del servidor y se la
sirve a tu página con CORS abierto.

## Instalación local

```bash
npm install
npm start
# escuchando en http://localhost:3000
```

Requiere Node 18+ (usa `fetch` nativo, sin dependencias extra para eso).

## Endpoints

- `GET /health` — estado del caché.
- `GET /api/gnss/raw-sample` — primeras líneas crudas del archivo de NGL,
  para verificar a ojo que el mapeo de columnas del `server.js` sigue
  siendo correcto (NGL puede cambiar su formato sin avisar).
- `GET /api/gnss?minlat=..&maxlat=..&minlon=..&maxlon=..&maxStations=8`
  Devuelve las estaciones GNSS reales dentro de esa caja delimitadora y su
  velocidad horizontal promedio.

Ejemplo:
```
GET /api/gnss?minlat=16&maxlat=18&minlon=-101.5&maxlon=-99
```
```json
{
  "source": "Nevada Geodetic Laboratory (MIDAS, geodesy.unr.edu)",
  "station_count": 6,
  "region_horizontal_velocity_mm_yr": 27.4,
  "stations": [ { "id": "OAXA", "horizontal_vel_mm_yr": 31.2, "...": "..." } ]
}
```

## Verifica el formato antes de confiar en los números

Antes de usar esto en serio, pega en el navegador (o `curl`) tu proxy
desplegado + `/api/gnss/raw-sample`, y compara las columnas contra el
README oficial de NGL:
https://geodesy.unr.edu/velocities/midas.readme.txt

Si NGL cambió el formato del archivo, el `server.js` va a necesitar que
ajustes los índices de columna en la función `parseMidasLine`.

## Desplegarlo para que el dashboard lo use desde internet

Cualquiera de estas opciones gratuitas/económicas sirve, porque el proyecto
no necesita base de datos ni almacenamiento persistente:

**Render.com**
1. Sube esta carpeta a un repositorio de GitHub.
2. En Render: New → Web Service → conecta el repo.
3. Build command: `npm install` · Start command: `npm start`.
4. Cuando termine el deploy, copia la URL pública (algo como
   `https://tu-proxy.onrender.com`).

**Railway.app**
1. New Project → Deploy from GitHub repo.
2. Railway detecta Node automáticamente y corre `npm start`.
3. Copia la URL pública generada.

**Localmente (para probar antes de desplegar)**
`npm start` y usa `http://localhost:3000` como URL del proxy — funciona
mientras tengas la terminal abierta y el dashboard corriendo en el mismo
equipo.

## Conéctalo al dashboard

En la sección experimental (violeta) del dashboard hay un campo "URL del
proxy GNSS". Pega ahí la URL pública de tu despliegue (sin `/` al final,
ej. `https://tu-proxy.onrender.com`) y guarda. El dashboard empezará a
sumar la señal de deformación real a su puntaje experimental.

## Seguridad / buenas prácticas si lo dejas público

- Por defecto el CORS está abierto (`*`). Si esto va a producción de
  verdad, restringe el origen con la variable de entorno `ALLOWED_ORIGIN`
  (ej. `ALLOWED_ORIGIN=https://tu-dominio.com`).
- Ya incluye un rate limiter básico (30 solicitudes/minuto por IP) para no
  golpear de más al servidor de NGL, que es infraestructura académica
  compartida.
- El catálogo completo se cachea 12 horas en memoria — se pierde si
  reinicias el proceso, y vuelve a descargarse en la primera solicitud.
