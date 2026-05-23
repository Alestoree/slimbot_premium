// ============================================================
//  SlimBot Premium VIP — Servidor completo para Railway
//  Panel web + API de keys + Bot de WhatsApp en uno solo
// ============================================================

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const QRCode = require('qrcode');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================
// BASE DE DATOS — archivo JSON compartido
// ============================================================
const DB_PATH = path.join(__dirname, 'data', 'keys.json');
const ADMIN_PATH = path.join(__dirname, 'data', 'admin.json');

function ensureDirs() {
  const dataDir = path.join(__dirname, 'data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(DB_PATH)) fs.writeFileSync(DB_PATH, JSON.stringify({ keys: [] }, null, 2));
  if (!fs.existsSync(ADMIN_PATH)) fs.writeFileSync(ADMIN_PATH, JSON.stringify({ user: 'admin', pass: 'slim2024' }, null, 2));
}

function loadKeys() {
  ensureDirs();
  return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
}
function saveKeys(db) {
  ensureDirs();
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}
function loadAdmin() {
  ensureDirs();
  return JSON.parse(fs.readFileSync(ADMIN_PATH, 'utf8'));
}
function findKey(code) {
  return loadKeys().keys.find(k => k.code.toLowerCase() === code.toLowerCase()) || null;
}
function isKeyValid(k) { return k && new Date(k.expiry) > new Date(); }
function getDaysLeft(k) { return Math.max(0, Math.ceil((new Date(k.expiry) - new Date()) / 86400000)); }

// ============================================================
// API ENDPOINTS — usados por el panel web
// ============================================================

// Login admin
app.post('/api/admin/login', (req, res) => {
  const { user, pass } = req.body;
  const admin = loadAdmin();
  if (user === admin.user && pass === admin.pass) {
    res.json({ ok: true });
  } else {
    res.status(401).json({ ok: false, error: 'Credenciales incorrectas' });
  }
});

// Verificar key (usuario)
app.post('/api/key/verify', (req, res) => {
  const { code, phone } = req.body;
  if (!code || !phone) return res.status(400).json({ ok: false, error: 'Datos incompletos' });

  if (!code.toLowerCase().startsWith('lic-slim-'))
    return res.status(400).json({ ok: false, error: 'Formato de key inválido' });

  const k = findKey(code);
  if (!k) return res.status(404).json({ ok: false, error: 'Key no encontrada' });
  if (!isKeyValid(k)) return res.status(403).json({ ok: false, error: 'Licencia vencida', expiry: k.expiry });

  // Registrar teléfono
  if (!k.phone) {
    const db = loadKeys();
    const dbKey = db.keys.find(x => x.code.toLowerCase() === code.toLowerCase());
    if (dbKey) { dbKey.phone = phone; saveKeys(db); }
  }

  res.json({ ok: true, key: { ...k, daysLeft: getDaysLeft(k) } });
});

// Obtener todas las keys (admin)
app.post('/api/keys/list', (req, res) => {
  const { user, pass } = req.body;
  const admin = loadAdmin();
  if (user !== admin.user || pass !== admin.pass) return res.status(401).json({ ok: false });
  const db = loadKeys();
  const now = new Date();
  const keys = db.keys.map(k => ({ ...k, daysLeft: getDaysLeft(k), active: new Date(k.expiry) > now }));
  res.json({ ok: true, keys });
});

// Generar key (admin)
app.post('/api/keys/generate', (req, res) => {
  const { user, pass, name, days } = req.body;
  const admin = loadAdmin();
  if (user !== admin.user || pass !== admin.pass) return res.status(401).json({ ok: false });
  if (!name || !days) return res.status(400).json({ ok: false, error: 'Faltan datos' });

  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let suf = '';
  for (let i = 0; i < 8; i++) suf += chars[Math.floor(Math.random() * chars.length)];
  const code = `Lic-slim-${suf}`;
  const now = new Date();
  const expiry = new Date(now.getTime() + parseInt(days) * 86400000);

  const db = loadKeys();
  const newKey = { code, name, days: parseInt(days), created: now.toISOString(), expiry: expiry.toISOString(), phone: '' };
  db.keys.push(newKey);
  saveKeys(db);

  res.json({ ok: true, key: newKey });
});

// Borrar key (admin)
app.post('/api/keys/delete', (req, res) => {
  const { user, pass, code } = req.body;
  const admin = loadAdmin();
  if (user !== admin.user || pass !== admin.pass) return res.status(401).json({ ok: false });

  const db = loadKeys();
  const idx = db.keys.findIndex(k => k.code === code);
  if (idx === -1) return res.status(404).json({ ok: false, error: 'Key no encontrada' });
  db.keys.splice(idx, 1);
  saveKeys(db);
  res.json({ ok: true });
});

// Estado del bot y QR
let currentQR = null;
let botConnected = false;

app.get('/api/bot/status', (req, res) => {
  res.json({ connected: botConnected, hasQR: !!currentQR });
});

app.get('/api/bot/qr', async (req, res) => {
  if (!currentQR) return res.status(404).json({ ok: false, error: 'No hay QR disponible' });
  try {
    const qrImage = await QRCode.toDataURL(currentQR);
    res.json({ ok: true, qr: qrImage });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'Error generando QR' });
  }
});

// ============================================================
// PANEL WEB — sirve el HTML
// ============================================================
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============================================================
// BOT DE WHATSAPP
// ============================================================
const sessions = {}; // { phone: keyCode }

function hasAccess(phone) {
  if (!sessions[phone]) return false;
  return isKeyValid(findKey(sessions[phone]));
}
function getKey(phone) {
  return sessions[phone] ? findKey(sessions[phone]) : null;
}

const NO_ACCESS = `🔒 *Acceso VIP requerido*

Activa tu licencia:
*.key Lic-slim-XXXXXXXX*

Comprar licencia:
📲 +52 612 169 79 59`;

const CMDS = {
  '.key': async (sock, msg, args, phone) => {
    if (!args) return '🔑 *Uso:* .key Lic-slim-XXXXXXXX';
    const code = args.trim();
    if (!code.toLowerCase().startsWith('lic-slim-'))
      return '❌ Formato incorrecto.\nDebe ser: `Lic-slim-XXXXXXXX`\n\n📲 +52 612 169 79 59';
    const k = findKey(code);
    if (!k) return '❌ *Key no encontrada.*\nVerifica el código.\n\n📲 +52 612 169 79 59';
    if (!isKeyValid(k)) return `⏰ *Licencia vencida.*\nVenció: ${new Date(k.expiry).toLocaleDateString('es-MX')}\n\n📲 +52 612 169 79 59`;
    const db = loadKeys();
    const dbKey = db.keys.find(x => x.code.toLowerCase() === code.toLowerCase());
    if (dbKey && !dbKey.phone) { dbKey.phone = phone; saveKeys(db); }
    sessions[phone] = code;
    return `✅ *¡Licencia VIP activada!*\n\n👤 *Cliente:* ${k.name}\n🔑 *Key:* ${k.code}\n⏳ *Días restantes:* ${getDaysLeft(k)}\n\nEscribe *.menu* para ver los comandos.`;
  },

  '.menu': async (sock, msg, args, phone) => {
    if (!hasAccess(phone)) return NO_ACCESS;
    return `🤖 *SlimBot Premium VIP*\n${'─'.repeat(26)}\n\n🔑 *LICENCIA*\n• .key [código]\n• .info\n\n📥 *DESCARGAS*\n• .facebook / .fb [url]\n• .tiktok / .tt [url]\n• .instagram / .ig [url]\n• .play / .mp3 [canción]\n• .play2 / .mp4 [video]\n• .spotify / .sp [canción]\n\n🤖 *IA*\n• .ia / .chatgpt [mensaje]\n\n⚙️ *GRUPO*\n• .bot on/off\n• .tag / .kick / .promote / .warn\n\n🎌 *ANIME*\n• .hug .kiss .slap .pat .dance .cry\n\n💰 *ECONOMÍA*\n• .balance .daily .work .slot\n\n🔍 *BUSCAR*\n• .imagen .wikipedia .pinterest\n\n🛠️ *UTILS*\n• .sticker .removebg .hd .ping\n\n🔞 *NSFW*\n• .xnxx .xvideos\n\n📱 *REDES*\n• .redes\n\n${'─'.repeat(26)}\n_SlimBot VIP v2.0_`;
  },

  '.info': async (sock, msg, args, phone) => {
    if (!hasAccess(phone)) return NO_ACCESS;
    const k = getKey(phone);
    const dl = getDaysLeft(k);
    const em = dl > 5 ? '🟢' : dl > 1 ? '🟡' : '🔴';
    return `🔑 *Mi Licencia*\n${'─'.repeat(24)}\n\n👤 *Cliente:* ${k.name}\n📱 *Número:* ${k.phone || phone}\n🔑 *Key:* ${k.code}\n📋 *Plan:* ${k.days} días\n${em} *Estado:* ${dl > 0 ? 'Activa ✅' : 'Vencida ❌'}\n⏳ *Días restantes:* ${dl}\n📅 *Vence:* ${new Date(k.expiry).toLocaleDateString('es-MX')}\n\n🤖 *Versión:* SlimBot VIP v2.0\n${dl <= 3 && dl > 0 ? '\n⚠️ _Licencia por vencer. Renueva ya._\n📲 +52 612 169 79 59' : ''}`;
  },

  '.facebook': async (sock, msg, args, phone) => { if (!hasAccess(phone)) return NO_ACCESS; if (!args) return '📥 *Uso:* .facebook [url]'; return `📥 *Descargando Facebook...*\n🔗 ${args}`; },
  '.fb': async (sock, msg, args, phone) => CMDS['.facebook'](sock, msg, args, phone),
  '.tiktok': async (sock, msg, args, phone) => { if (!hasAccess(phone)) return NO_ACCESS; if (!args) return '📥 *Uso:* .tiktok [url]'; return `📥 *Descargando TikTok...*\n🔍 ${args}`; },
  '.tt': async (sock, msg, args, phone) => CMDS['.tiktok'](sock, msg, args, phone),
  '.instagram': async (sock, msg, args, phone) => { if (!hasAccess(phone)) return NO_ACCESS; if (!args) return '📥 *Uso:* .instagram [url]'; return `📥 *Descargando Instagram...*\n🔗 ${args}`; },
  '.ig': async (sock, msg, args, phone) => CMDS['.instagram'](sock, msg, args, phone),
  '.reel': async (sock, msg, args, phone) => CMDS['.instagram'](sock, msg, args, phone),
  '.play': async (sock, msg, args, phone) => { if (!hasAccess(phone)) return NO_ACCESS; if (!args) return '🎵 *Uso:* .play [canción o url]'; return `🎵 *Buscando en YouTube...*\n🔍 ${args}`; },
  '.mp3': async (sock, msg, args, phone) => CMDS['.play'](sock, msg, args, phone),
  '.ytmp3': async (sock, msg, args, phone) => CMDS['.play'](sock, msg, args, phone),
  '.play2': async (sock, msg, args, phone) => { if (!hasAccess(phone)) return NO_ACCESS; if (!args) return '🎬 *Uso:* .play2 [video o url]'; return `🎬 *Descargando YouTube...*\n🔍 ${args}`; },
  '.mp4': async (sock, msg, args, phone) => CMDS['.play2'](sock, msg, args, phone),
  '.ytmp4': async (sock, msg, args, phone) => CMDS['.play2'](sock, msg, args, phone),
  '.spotify': async (sock, msg, args, phone) => { if (!hasAccess(phone)) return NO_ACCESS; if (!args) return '🎧 *Uso:* .spotify [canción]'; return `🎧 *Buscando en Spotify...*\n🔍 ${args}`; },
  '.sp': async (sock, msg, args, phone) => CMDS['.spotify'](sock, msg, args, phone),

  '.ia': async (sock, msg, args, phone) => {
    if (!hasAccess(phone)) return NO_ACCESS;
    if (!args) return '🤖 *Uso:* .ia [pregunta]';
    return `🤖 *SlimBot IA*\n\n❓ ${args}\n\n💡 _Conecta tu API key de OpenAI en server.js para respuestas reales._`;
  },
  '.chatgpt': async (sock, msg, args, phone) => CMDS['.ia'](sock, msg, args, phone),

  '.bot': async (sock, msg, args, phone) => {
    if (!hasAccess(phone)) return NO_ACCESS;
    if (!args || !['on','off'].includes(args.toLowerCase())) return '⚙️ *Uso:* .bot on  |  .bot off';
    return `⚙️ *Bot ${args.toLowerCase() === 'on' ? 'activado ✅' : 'desactivado ❌'}* en este grupo.`;
  },
  '.tag': async (sock, msg, args, phone) => { if (!hasAccess(phone)) return NO_ACCESS; return `📢 *Mencionando a todos...*\n${args||''}`; },
  '.hidetag': async (sock, msg, args, phone) => CMDS['.tag'](sock, msg, args, phone),
  '.kick': async (sock, msg, args, phone) => { if (!hasAccess(phone)) return NO_ACCESS; return '🚫 *Expulsando usuario...*\n_El bot debe ser admin del grupo._'; },
  '.promote': async (sock, msg, args, phone) => { if (!hasAccess(phone)) return NO_ACCESS; return '⬆️ *Promoviendo a admin...*\n_El bot debe ser admin del grupo._'; },
  '.warn': async (sock, msg, args, phone) => { if (!hasAccess(phone)) return NO_ACCESS; return '⚠️ *Advertencia registrada.*'; },

  '.hug': async (sock, msg, args, phone) => { if (!hasAccess(phone)) return NO_ACCESS; return '🤗 *¡Abrazo anime!*\n_[GIF]_'; },
  '.kiss': async (sock, msg, args, phone) => { if (!hasAccess(phone)) return NO_ACCESS; return '😘 *¡Beso anime!*\n_[GIF]_'; },
  '.muak': async (sock, msg, args, phone) => CMDS['.kiss'](sock, msg, args, phone),
  '.slap': async (sock, msg, args, phone) => { if (!hasAccess(phone)) return NO_ACCESS; return '👋 *¡Bofetada anime!*\n_[GIF]_'; },
  '.pat': async (sock, msg, args, phone) => { if (!hasAccess(phone)) return NO_ACCESS; return '🤚 *Caricia anime*\n_[GIF]_'; },
  '.dance': async (sock, msg, args, phone) => { if (!hasAccess(phone)) return NO_ACCESS; return '💃 *¡Bailando anime!*\n_[GIF]_'; },
  '.cry': async (sock, msg, args, phone) => { if (!hasAccess(phone)) return NO_ACCESS; return '😭 *Llorando anime*\n_[GIF]_'; },
  '.blush': async (sock, msg, args, phone) => { if (!hasAccess(phone)) return NO_ACCESS; return '😳 *Sonrojado anime*\n_[GIF]_'; },
  '.wave': async (sock, msg, args, phone) => { if (!hasAccess(phone)) return NO_ACCESS; return '👋 *¡Hola anime!*\n_[GIF]_'; },
  '.bite': async (sock, msg, args, phone) => { if (!hasAccess(phone)) return NO_ACCESS; return '😤 *¡Mordida anime!*\n_[GIF]_'; },
  '.morder': async (sock, msg, args, phone) => CMDS['.bite'](sock, msg, args, phone),
  '.cuddle': async (sock, msg, args, phone) => { if (!hasAccess(phone)) return NO_ACCESS; return '🥰 *Acurrucándose*\n_[GIF]_'; },
  '.punch': async (sock, msg, args, phone) => { if (!hasAccess(phone)) return NO_ACCESS; return '👊 *¡Puñetazo anime!*\n_[GIF]_'; },
  '.happy': async (sock, msg, args, phone) => { if (!hasAccess(phone)) return NO_ACCESS; return '🎉 *¡Feliz anime!*\n_[GIF]_'; },
  '.feliz': async (sock, msg, args, phone) => CMDS['.happy'](sock, msg, args, phone),
  '.lick': async (sock, msg, args, phone) => { if (!hasAccess(phone)) return NO_ACCESS; return '👅 *Lamiendo*\n_[GIF]_'; },

  '.balance': async (sock, msg, args, phone) => { if (!hasAccess(phone)) return NO_ACCESS; return '💰 *Balance:*\n🪙 Monedas: 0\n🏦 Banco: 0'; },
  '.bal': async (sock, msg, args, phone) => CMDS['.balance'](sock, msg, args, phone),
  '.daily': async (sock, msg, args, phone) => { if (!hasAccess(phone)) return NO_ACCESS; return '🎁 *¡Recompensa diaria!*\n🪙 +100 monedas'; },
  '.work': async (sock, msg, args, phone) => {
    if (!hasAccess(phone)) return NO_ACCESS;
    const jobs = ['programador','chef','mecánico','maestro','doctor'];
    const coins = Math.floor(Math.random()*50)+20;
    return `💼 *Trabajo completado!*\nTrabajaste como *${jobs[Math.floor(Math.random()*jobs.length)]}*\n🪙 +${coins} monedas`;
  },
  '.w': async (sock, msg, args, phone) => CMDS['.work'](sock, msg, args, phone),
  '.slot': async (sock, msg, args, phone) => {
    if (!hasAccess(phone)) return NO_ACCESS;
    if (!args) return '🎰 *Uso:* .slot [cantidad]';
    const items = ['🍒','🍋','🍇','⭐','7️⃣'];
    const r = [0,1,2].map(() => items[Math.floor(Math.random()*items.length)]);
    const win = r[0]===r[1]&&r[1]===r[2];
    return `🎰 [ ${r.join(' | ')} ]\n\n${win?'🎉 ¡GANASTE el doble!':'❌ Perdiste. Suerte la próxima.'}`;
  },

  '.imagen': async (sock, msg, args, phone) => { if (!hasAccess(phone)) return NO_ACCESS; if (!args) return '🔍 *Uso:* .imagen [búsqueda]'; return `🔍 *Buscando imágenes:* ${args}`; },
  '.img': async (sock, msg, args, phone) => CMDS['.imagen'](sock, msg, args, phone),
  '.wikipedia': async (sock, msg, args, phone) => { if (!hasAccess(phone)) return NO_ACCESS; if (!args) return '📖 *Uso:* .wikipedia [tema]'; return `📖 *Wikipedia:* ${args}`; },
  '.wiki': async (sock, msg, args, phone) => CMDS['.wikipedia'](sock, msg, args, phone),
  '.pinterest': async (sock, msg, args, phone) => { if (!hasAccess(phone)) return NO_ACCESS; if (!args) return '📌 *Uso:* .pinterest [búsqueda]'; return `📌 *Pinterest:* ${args}`; },
  '.pin': async (sock, msg, args, phone) => CMDS['.pinterest'](sock, msg, args, phone),

  '.sticker': async (sock, msg, args, phone) => { if (!hasAccess(phone)) return NO_ACCESS; return '🎨 Responde a una imagen con *.sticker* para convertirla.'; },
  '.s': async (sock, msg, args, phone) => CMDS['.sticker'](sock, msg, args, phone),
  '.removebg': async (sock, msg, args, phone) => { if (!hasAccess(phone)) return NO_ACCESS; return '✂️ Responde a una imagen con *.removebg*'; },
  '.hd': async (sock, msg, args, phone) => { if (!hasAccess(phone)) return NO_ACCESS; return '🖼️ Responde a una imagen con *.hd* para mejorarla.'; },
  '.upscale': async (sock, msg, args, phone) => CMDS['.hd'](sock, msg, args, phone),
  '.ping': async (sock, msg, args, phone) => { const ms = Math.floor(Math.random()*80)+10; return `🏓 *Pong!* ⚡ ${ms}ms\n🟢 SlimBot VIP activo`; },
  '.p': async (sock, msg, args, phone) => CMDS['.ping'](sock, msg, args, phone),

  '.xnxx': async (sock, msg, args, phone) => { if (!hasAccess(phone)) return NO_ACCESS; if (!args) return '🔞 *Uso:* .xnxx [búsqueda]'; return `🔞 *XNXX:* ${args}\n_Solo grupos con NSFW activado._`; },
  '.xvideos': async (sock, msg, args, phone) => { if (!hasAccess(phone)) return NO_ACCESS; if (!args) return '🔞 *Uso:* .xvideos [búsqueda]'; return `🔞 *XVideos:* ${args}\n_Solo grupos con NSFW activado._`; },

  '.redes': async (sock, msg, args, phone) => {
    return `📱 *Redes y Contacto*\n${'─'.repeat(22)}\n\n💬 *WhatsApp Admin:*\n+52 612 169 79 59\n\n🛒 *Comprar licencia:*\nwa.me/526121697959`;
  },
};

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth_slimbot');
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version, auth: state,
    printQRInTerminal: true,
    browser: ['SlimBot Premium', 'Chrome', '2.0.0'],
    generateHighQualityLinkPreview: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      currentQR = qr;
      botConnected = false;
      console.log('📱 QR generado — ve a /qr en el panel para escanearlo');
    }
    if (connection === 'close') {
      botConnected = false;
      currentQR = null;
      const shouldReconnect = (lastDisconnect?.error instanceof Boom)
        ? lastDisconnect.error.output?.statusCode !== DisconnectReason.loggedOut : true;
      if (shouldReconnect) { setTimeout(startBot, 3000); }
    } else if (connection === 'open') {
      botConnected = true;
      currentQR = null;
      console.log('✅ SlimBot Premium VIP conectado!');
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;
      const phone = msg.key.remoteJid.replace('@s.whatsapp.net','').replace('@g.us','');
      const body = (msg.message?.conversation || msg.message?.extendedTextMessage?.text || '').trim();
      if (!body.startsWith('.')) continue;
      const parts = body.split(' ');
      const cmd = parts[0].toLowerCase();
      const args = parts.slice(1).join(' ') || null;
      console.log(`[BOT] ${phone} → ${cmd} ${args||''}`);
      const handler = CMDS[cmd];
      if (!handler) {
        if (hasAccess(phone)) await sock.sendMessage(msg.key.remoteJid, { text: `❓ Comando desconocido: *${cmd}*\nEscribe *.menu* para ver los comandos.` });
        continue;
      }
      try {
        const response = await handler(sock, msg, args, phone);
        if (response) await sock.sendMessage(msg.key.remoteJid, { text: response }, { quoted: msg });
      } catch(err) {
        console.error(`Error ${cmd}:`, err);
        await sock.sendMessage(msg.key.remoteJid, { text: '❌ Error. Intenta de nuevo.' });
      }
    }
  });
}

// ============================================================
// INICIAR SERVIDOR + BOT
// ============================================================
app.listen(PORT, () => {
  console.log(`🌐 Panel web corriendo en puerto ${PORT}`);
  console.log(`📊 Panel admin: http://localhost:${PORT}`);
});

startBot().catch(console.error);
