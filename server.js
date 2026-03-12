require('dotenv').config();
const express = require('express');
const WebSocket = require('ws');

const cors = require('cors');
const app = express();
const PORT = process.env.PORT || 3001;
const API_KEY = process.env.AISSTREAM_API_KEY || '034a5437399dd60d299c01ae1b7ec89920a4014f';
const PROXY_SECRET = process.env.PROXY_SECRET || 'war-maritime-2026';

// CORS — allow war.direct + localhost
app.use(cors({
  origin: ['https://war.direct', 'https://ship.war.direct', 'https://palegreen-stork-677103.hostingersite.com', 'http://localhost:8888', 'http://localhost:3000'],
  methods: ['GET']
}));

// ── Vessel cache (MMSI → latest position) ──
const vessels = new Map();
const VESSEL_TTL = 600000; // 10 min — drop stale vessels
const MAX_VESSELS = 500;

// ── Bounding boxes: Strait of Hormuz + Persian Gulf + Gulf of Oman ──
const BOUNDING_BOXES = [
  [[23.5, 51.0], [30.0, 60.0]]  // Wide coverage: Persian Gulf + Strait + Gulf of Oman
];

// ── Ship type mapping (AIS type codes → human labels) ──
function shipType(code) {
  if (!code) return 'Unknown';
  const c = parseInt(code);
  if (c >= 70 && c <= 79) return 'Cargo';
  if (c >= 80 && c <= 89) return 'Tanker';
  if (c === 30) return 'Fishing';
  if (c >= 40 && c <= 49) return 'High Speed Craft';
  if (c >= 50 && c <= 59) return 'Special Craft';
  if (c >= 60 && c <= 69) return 'Passenger';
  if (c === 31 || c === 32) return 'Tug';
  if (c === 33) return 'Dredger';
  if (c === 35) return 'Military';
  if (c === 36) return 'Sailing';
  if (c === 37) return 'Pleasure Craft';
  if (c >= 20 && c <= 29) return 'WIG';
  return 'Other';
}

// ── Country from MMSI MID (Maritime Identification Digits) ──
function countryFromMMSI(mmsi) {
  if (!mmsi) return '';
  const s = String(mmsi);
  if (s.length < 3) return '';
  const mid = parseInt(s.substring(0, 3));
  const map = {
    422: 'Iran', 470: 'UAE', 461: 'Pakistan', 419: 'India',
    416: 'Israel', 466: 'Qatar', 408: 'Bahrain', 447: 'Kuwait',
    403: 'Saudi Arabia', 473: 'Oman', 529: 'Singapore', 538: 'Marshall Islands',
    636: 'Liberia', 477: 'Marshall Islands', 210: 'Cyprus', 256: 'Malta',
    209: 'Belgium', 211: 'Germany', 215: 'Malta', 218: 'Germany',
    219: 'Denmark', 220: 'Denmark', 224: 'Spain', 225: 'Spain',
    226: 'France', 227: 'France', 228: 'France', 229: 'Malta',
    230: 'Finland', 231: 'Faroe Islands', 232: 'UK', 233: 'UK',
    234: 'UK', 235: 'UK', 236: 'UK', 237: 'Greece', 238: 'Croatia',
    239: 'Greece', 240: 'Greece', 241: 'Greece', 242: 'Morocco',
    243: 'Hungary', 244: 'Netherlands', 245: 'Netherlands', 246: 'Netherlands',
    247: 'Italy', 248: 'Malta', 249: 'Malta', 250: 'Ireland',
    255: 'Madeira', 256: 'Malta', 257: 'Norway', 258: 'Norway',
    259: 'Norway', 261: 'Poland', 263: 'Portugal', 265: 'Sweden',
    266: 'Sweden', 269: 'Switzerland', 271: 'Turkey', 272: 'Ukraine',
    273: 'Russia', 303: 'USA', 304: 'Antigua', 305: 'Antigua',
    306: 'Curacao', 307: 'Aruba', 308: 'Bahamas', 309: 'Bahamas',
    310: 'Bermuda', 311: 'Bahamas', 312: 'Belize', 314: 'Barbados',
    316: 'Canada', 319: 'Cayman Islands', 325: 'Jamaica', 327: 'Jamaica',
    338: 'USA', 339: 'USA', 341: 'USA', 351: 'USA', 352: 'USA',
    353: 'USA', 354: 'USA', 355: 'USA', 356: 'USA', 357: 'USA',
    366: 'USA', 367: 'USA', 368: 'USA', 369: 'USA',
    370: 'Panama', 371: 'Panama', 372: 'Panama', 373: 'Panama',
    374: 'Panama', 375: 'Panama', 376: 'Panama', 377: 'Panama',
    378: 'UK (Overseas)', 412: 'China', 413: 'China', 414: 'China',
    431: 'Japan', 432: 'Japan', 440: 'South Korea', 441: 'South Korea',
    501: 'France (Overseas)', 503: 'Australia', 525: 'Indonesia',
    533: 'Malaysia', 548: 'Philippines', 563: 'Singapore', 564: 'Singapore',
    565: 'Singapore', 566: 'Singapore', 567: 'Thailand',
    572: 'Tuvalu', 576: 'Tonga', 577: 'Vanuatu'
  };
  return map[mid] || '';
}

// ── Connect to AISStream WebSocket ──
let ws = null;
let reconnectTimer = null;
let messageCount = 0;

function connectAIS() {
  if (ws && ws.readyState === WebSocket.OPEN) return;

  console.log('[AIS] Connecting to AISStream...');
  ws = new WebSocket('wss://stream.aisstream.io/v0/stream');

  ws.on('open', () => {
    console.log('[AIS] Connected. Subscribing to Strait of Hormuz / Persian Gulf...');
    ws.send(JSON.stringify({
      APIKey: API_KEY,
      BoundingBoxes: BOUNDING_BOXES,
      FilterMessageTypes: ['PositionReport', 'ShipStaticData', 'StandardClassBPositionReport']
    }));
  });

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      const meta = msg.MetaData;
      if (!meta || !meta.MMSI) return;

      const mmsi = String(meta.MMSI);
      messageCount++;

      // Get or create vessel entry
      const existing = vessels.get(mmsi) || {};

      // Update position from PositionReport / StandardClassBPositionReport
      const posMsg = msg.Message?.PositionReport || msg.Message?.StandardClassBPositionReport;
      if (posMsg) {
        existing.mmsi = mmsi;
        existing.lat = meta.latitude;
        existing.lon = meta.longitude;
        existing.heading = posMsg.TrueHeading !== 511 ? posMsg.TrueHeading : (posMsg.Cog || 0);
        existing.speed = posMsg.Sog || 0;
        existing.course = posMsg.Cog || 0;
        existing.navStatus = posMsg.NavigationalStatus;
        existing.updated = Date.now();
        existing.name = meta.ShipName?.trim() || existing.name || '';
        existing.country = meta.country_iso || countryFromMMSI(mmsi) || existing.country || '';
      }

      // Update static data from ShipStaticData
      const staticMsg = msg.Message?.ShipStaticData;
      if (staticMsg) {
        existing.mmsi = mmsi;
        existing.name = staticMsg.Name?.trim() || meta.ShipName?.trim() || existing.name || '';
        existing.shipType = staticMsg.Type || existing.shipType;
        existing.callSign = staticMsg.CallSign?.trim() || existing.callSign || '';
        existing.imo = staticMsg.ImoNumber || existing.imo;
        existing.destination = staticMsg.Destination?.trim() || existing.destination || '';
        existing.length = staticMsg.Dimension?.A + staticMsg.Dimension?.B || existing.length;
        existing.width = staticMsg.Dimension?.C + staticMsg.Dimension?.D || existing.width;
        existing.country = meta.country_iso || countryFromMMSI(mmsi) || existing.country || '';
        if (!existing.updated) existing.updated = Date.now();
      }

      vessels.set(mmsi, existing);

      // Prune stale vessels
      if (vessels.size > MAX_VESSELS + 50) {
        const now = Date.now();
        for (const [k, v] of vessels) {
          if (now - v.updated > VESSEL_TTL) vessels.delete(k);
        }
      }
    } catch (e) {
      // Skip malformed messages
    }
  });

  ws.on('close', (code, reason) => {
    console.log('[AIS] Disconnected. Code:', code, 'Reason:', reason?.toString() || 'none', '— Reconnecting in 10s...');
    reconnectTimer = setTimeout(connectAIS, 10000);
  });

  ws.on('error', (err) => {
    console.error('[AIS] Error:', err.message);
    try { ws.close(); } catch(e) {}
  });
}

// ── Auth middleware ──
function checkAuth(req, res, next) {
  const key = req.headers['x-proxy-key'] || req.query.secret;
  if (key !== PROXY_SECRET) return res.status(403).json({ error: 'Unauthorized' });
  next();
}

// ── API endpoints ──

// GET /vessels — all current vessels in the bounding box
app.get('/vessels', checkAuth, (req, res) => {
  const now = Date.now();
  const result = [];

  for (const [mmsi, v] of vessels) {
    // Skip stale (>10min) or vessels without position
    if (!v.lat || !v.lon || (now - v.updated > VESSEL_TTL)) continue;

    result.push({
      mmsi: v.mmsi,
      name: v.name || 'Unknown',
      lat: v.lat,
      lon: v.lon,
      heading: v.heading || 0,
      speed: v.speed || 0,
      course: v.course || 0,
      type: shipType(v.shipType),
      typeCode: v.shipType || 0,
      country: v.country || '',
      destination: v.destination || '',
      length: v.length || 0,
      callSign: v.callSign || '',
      imo: v.imo || 0,
      updated: v.updated
    });
  }

  // Sort by type priority: Tanker first (most relevant to Hormuz), then Cargo, then rest
  result.sort((a, b) => {
    const pri = { 'Tanker': 0, 'Cargo': 1 };
    return (pri[a.type] ?? 9) - (pri[b.type] ?? 9);
  });

  res.json({
    vessels: result,
    count: result.length,
    messages_received: messageCount,
    uptime: Math.floor(process.uptime())
  });
});

// GET /stats — quick health check
app.get('/stats', checkAuth, (req, res) => {
  res.json({
    vessels_cached: vessels.size,
    messages_received: messageCount,
    ws_state: ws ? ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'][ws.readyState] : 'NONE',
    uptime: Math.floor(process.uptime())
  });
});

// GET /health — public health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    api_key_set: !!API_KEY,
    api_key_preview: API_KEY ? API_KEY.substring(0, 6) + '...' : 'MISSING',
    ws_state: ws ? ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'][ws.readyState] : 'NONE',
    vessels: vessels.size,
    uptime: Math.floor(process.uptime())
  });
});

// ── Start ──
app.listen(PORT, () => {
  console.log(`[Maritime] Listening on port ${PORT}`);
  connectAIS();
});
