const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const QRCode = require('qrcode');

const app = express();
const PORT = process.env.PORT || 3000;
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================
// BASE DE DATOS
// ============================================================
const DATA = path.join(__dirname, 'data');
const KEYS_F = path.join(DATA, 'keys.json');
const USERS_F = path.join(DATA, 'users.json');
const ADMIN_F = path.join(DATA, 'admin.json');

function init() {
  if (!fs.existsSync(DATA)) fs.mkdirSync(DATA, { recursive: true });
  if (!fs.existsSync(KEYS_F)) fs.writeFileSync(KEYS_F, JSON.stringify({ keys: [] }, null, 2));
  if (!fs.existsSync(USERS_F)) fs.writeFileSync(USERS_F, JSON.stringify({ users: [] }, null, 2));
  if (!fs.existsSync(ADMIN_F)) fs.writeFileSync(ADMIN_F, JSON.stringify({ user: 'admin', pass: 'slim2024' }, null, 2));
}

const db = {
  keys: () => { init(); return JSON.parse(fs.readFileSync(KEYS_F, 'utf8')); },
  saveKeys: (d) => fs.writeFileSync(KEYS_F, JSON.stringify(d, null, 2)),
  users: () => { init(); return JSON.parse(fs.readFileSync(USERS_F, 'utf8')); },
  saveUsers: (d) => fs.writeFileSync(USERS_F, JSON.stringify(d, null, 2)),
  admin: () => { init(); return JSON.parse(fs.readFileSync(ADMIN_F, 'utf8')); },
};

function hash(str) { return crypto.createHash('sha256').update(str).digest('hex'); }
function genKey(type) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = ''; for (let i = 0; i < 8; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return type === 'deluxe' ? `Lic-deluxe-${s}` : `Lic-slim-${s}`;
}
function isValid(k) { return k && new Date(k.expiry) > new Date(); }
function daysLeft(k) { return Math.max(0, Math.ceil((new Date(k.expiry) - new Date()) / 86400000)); }

const PLANS = {
  normal: { '1': 1, '7': 5, '15': 10, '30': 15, '60': 20 },
  deluxe: { '1': 0.5, '7': 3, '15': 6, '30': 10, '60': 15 }
};

// ============================================================
// AUTH USUARIOS
// ============================================================
app.post('/api/register', (req, res) => {
  const { name, email, apodo, pass } = req.body;
  if (!name || !email || !apodo || !pass) return res.status(400).json({ ok: false, error: 'Todos los campos son requeridos' });
  const d = db.users();
  if (d.users.find(u => u.email === email.toLowerCase())) return res.status(400).json({ ok: false, error: 'El correo ya está registrado' });
  if (d.users.find(u => u.apodo.toLowerCase() === apodo.toLowerCase())) return res.status(400).json({ ok: false, error: 'El apodo ya está en uso' });
  const user = { id: Date.now().toString(), name, email: email.toLowerCase(), apodo, pass: hash(pass), saldo: 0, created: new Date().toISOString() };
  d.users.push(user);
  db.saveUsers(d);
  const { pass: _, ...safe } = user;
  res.json({ ok: true, user: safe });
});

app.post('/api/login', (req, res) => {
  const { apodo, pass } = req.body;
  if (!apodo || !pass) return res.status(400).json({ ok: false, error: 'Ingresa tu apodo y contraseña' });
  const d = db.users();
  const user = d.users.find(u => (u.apodo.toLowerCase() === apodo.toLowerCase() || u.email === apodo.toLowerCase()) && u.pass === hash(pass));
  if (!user) return res.status(401).json({ ok: false, error: 'Apodo o contraseña incorrectos' });
  const { pass: _, ...safe } = user;
  res.json({ ok: true, user: safe });
});

app.post('/api/admin/login', (req, res) => {
  const { user, pass } = req.body;
  const a = db.admin();
  if (user === a.user && pass === a.pass) res.json({ ok: true });
  else res.status(401).json({ ok: false, error: 'Credenciales incorrectas' });
});

// ============================================================
// COMPRAR KEY (con saldo)
// ============================================================
app.post('/api/buy', (req, res) => {
  const { userId, tipo, dias } = req.body;
  if (!userId || !tipo || !dias) return res.status(400).json({ ok: false, error: 'Datos incompletos' });
  const precio = PLANS[tipo]?.[dias];
  if (!precio) return res.status(400).json({ ok: false, error: 'Plan inválido' });
  const ud = db.users();
  const user = ud.users.find(u => u.id === userId);
  if (!user) return res.status(404).json({ ok: false, error: 'Usuario no encontrado' });
  if (user.saldo < precio) return res.status(400).json({ ok: false, error: `Saldo insuficiente. Necesitas $${precio}, tienes $${user.saldo}` });
  // Descontar saldo
  user.saldo = parseFloat((user.saldo - precio).toFixed(2));
  db.saveUsers(ud);
  // Generar key
  const code = genKey(tipo);
  const now = new Date();
  const expiry = new Date(now.getTime() + parseInt(dias) * 86400000);
  const kd = db.keys();
  const newKey = { code, userId, userName: user.name, type: tipo, days: parseInt(dias), created: now.toISOString(), expiry: expiry.toISOString(), phone: '' };
  kd.keys.push(newKey);
  db.saveKeys(kd);
  res.json({ ok: true, key: newKey, saldoRestante: user.saldo });
});

// ============================================================
// KEYS DEL USUARIO
// ============================================================
app.post('/api/mis-keys', (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ ok: false });
  const kd = db.keys();
  const keys = kd.keys.filter(k => k.userId === userId).map(k => ({ ...k, daysLeft: daysLeft(k), active: isValid(k) }));
  res.json({ ok: true, keys });
});

// ============================================================
// ADMIN — usuarios y saldo
// ============================================================
app.post('/api/admin/users', (req, res) => {
  const { user, pass } = req.body;
  const a = db.admin();
  if (user !== a.user || pass !== a.pass) return res.status(401).json({ ok: false });
  const d = db.users();
  res.json({ ok: true, users: d.users.map(u => { const { pass: _, ...s } = u; return s; }) });
});

app.post('/api/admin/saldo', (req, res) => {
  const { user, pass, userId, monto } = req.body;
  const a = db.admin();
  if (user !== a.user || pass !== a.pass) return res.status(401).json({ ok: false });
  const d = db.users();
  const u = d.users.find(x => x.id === userId);
  if (!u) return res.status(404).json({ ok: false, error: 'Usuario no encontrado' });
  u.saldo = parseFloat((u.saldo + parseFloat(monto)).toFixed(2));
  db.saveUsers(d);
  res.json({ ok: true, saldo: u.saldo });
});

app.post('/api/admin/keys', (req, res) => {
  const { user, pass } = req.body;
  const a = db.admin();
  if (user !== a.user || pass !== a.pass) return res.status(401).json({ ok: false });
  const kd = db.keys();
  res.json({ ok: true, keys: kd.keys.map(k => ({ ...k, daysLeft: daysLeft(k), active: isValid(k) })) });
});

app.post('/api/admin/genkey', (req, res) => {
  const { user, pass, name, tipo, dias } = req.body;
  const a = db.admin();
  if (user !== a.user || pass !== a.pass) return res.status(401).json({ ok: false });
  const code = genKey(tipo || 'normal');
  const now = new Date();
  const expiry = new Date(now.getTime() + parseInt(dias) * 86400000);
  const kd = db.keys();
  const newKey = { code, userId: null, userName: name, type: tipo || 'normal', days: parseInt(dias), created: now.toISOString(), expiry: expiry.toISOString(), phone: '' };
  kd.keys.push(newKey);
  db.saveKeys(kd);
  res.json({ ok: true, key: newKey });
});

app.post('/api/admin/delkey', (req, res) => {
  const { user, pass, code } = req.body;
  const a = db.admin();
  if (user !== a.user || pass !== a.pass) return res.status(401).json({ ok: false });
  const kd = db.keys();
  kd.keys = kd.keys.filter(k => k.code !== code);
  db.saveKeys(kd);
  res.json({ ok: true });
});

// QR y estado del bot
let currentQR = null, botConnected = false;
app.get('/api/bot/status', (req, res) => res.json({ connected: botConnected, hasQR: !!currentQR }));
app.get('/api/bot/qr', async (req, res) => {
  if (!currentQR) return res.status(404).json({ ok: false });
  try { const q = await QRCode.toDataURL(currentQR); res.json({ ok: true, qr: q }); }
  catch (e) { res.status(500).json({ ok: false }); }
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ============================================================
// BOT WHATSAPP
// ============================================================
const sessions = {};
function hasAccess(phone) { if (!sessions[phone]) return false; const k = findKeyByPhone(phone); return k && isValid(k); }
function hasDeluxe(phone) { if (!sessions[phone]) return false; const k = findKeyByPhone(phone); return k && isValid(k) && k.type === 'deluxe'; }
function findKeyByPhone(phone) {
  const kd = db.keys();
  return kd.keys.find(k => k.phone === phone && isValid(k)) || null;
}
function findKeyByCode(code) { return db.keys().keys.find(k => k.code.toLowerCase() === code.toLowerCase()) || null; }

const DELUXE_ONLY = `🔒 *Función exclusiva KEY Deluxe*\n\nEsta función no está disponible en tu plan actual.\n\n💎 Actualiza a Deluxe para acceder.\n🌐 slimbot-premium.onrender.com`;
const NO_ACCESS = `🔒 *Acceso requerido*\n\nActiva tu licencia:\n*.key Lic-slim-XXXXXXXX*\n*o*\n*.key Lic-deluxe-XXXXXXXX*\n\n🌐 Compra tu licencia:\nslimbot-premium.onrender.com`;

const CMDS = {
  '.key': async (sock, msg, args, phone) => {
    if (!args) return '🔑 *Uso:* .key Lic-slim-XXXXXXXX\n\nIngresa tu código de licencia.';
    const code = args.trim();
    if (!code.toLowerCase().startsWith('lic-slim-') && !code.toLowerCase().startsWith('lic-deluxe-'))
      return '❌ Formato incorrecto.\nFormatos válidos:\n• `Lic-slim-XXXXXXXX`\n• `Lic-deluxe-XXXXXXXX`';
    const k = findKeyByCode(code);
    if (!k) return '❌ *Key no encontrada.*\n\n🌐 Compra tu licencia:\nslimbot-premium.onrender.com';
    if (!isValid(k)) return `⏰ *Licencia vencida.*\nVenció: ${new Date(k.expiry).toLocaleDateString('es-MX')}\n\n🌐 Renueva en:\nslimbot-premium.onrender.com`;
    const kd = db.keys();
    const dbKey = kd.keys.find(x => x.code.toLowerCase() === code.toLowerCase());
    if (dbKey) { dbKey.phone = phone; db.saveKeys(kd); }
    sessions[phone] = code;
    const tipo = k.type === 'deluxe' ? '💎 KEY Deluxe' : '🔑 KEY Normal';
    return `✅ *¡Licencia activada!*\n\n👤 *Cliente:* ${k.userName}\n${tipo}\n⏳ *Días restantes:* ${daysLeft(k)}\n\nEscribe *.menu* para ver tus comandos.`;
  },

  '.menu': async (sock, msg, args, phone) => {
    if (!hasAccess(phone)) return NO_ACCESS;
    const deluxe = hasDeluxe(phone);
    const d = deluxe ? '✅' : '🔒';
    return `🤖 *SlimBot Premium*\n${'─'.repeat(26)}\n\n🔑 *LICENCIA*\n• .key / .info / .menu\n\n📥 *DESCARGAS GRATIS*\n• .play / .mp3 — YouTube audio\n• .play2 / .mp4 — YouTube video\n• .spotify — Spotify\n\n📥 *DESCARGAS DELUXE* ${d}\n• .facebook / .fb\n• .tiktok / .tt\n• .instagram / .ig\n\n🤖 *IA*\n• .ia / .chatgpt\n\n🎌 *ANIME DELUXE* ${d}\n• .hug .kiss .slap .pat .dance .cry\n\n💰 *ECONOMÍA*\n• .balance .daily .work .slot\n\n🔍 *BUSCAR DELUXE* ${d}\n• .imagen .wikipedia .pinterest\n\n🛠️ *UTILS*\n• .sticker .removebg .hd .ping\n\n🔞 *NSFW DELUXE* ${d}\n• .xnxx .xvideos\n\n📱 *REDES*\n• .redes\n\n${'─'.repeat(26)}\n${deluxe ? '💎 _Tienes acceso Deluxe completo_' : '🔑 _Plan Normal — Actualiza a Deluxe_'}\n_SlimBot v2.0_`;
  },

  '.info': async (sock, msg, args, phone) => {
    if (!hasAccess(phone)) return NO_ACCESS;
    const k = findKeyByPhone(phone);
    const dl = daysLeft(k);
    const em = dl > 5 ? '🟢' : dl > 1 ? '🟡' : '🔴';
    const tipo = k.type === 'deluxe' ? '💎 KEY Deluxe' : '🔑 KEY Normal';
    return `ℹ️ *Información de Licencia*\n${'─'.repeat(24)}\n\n👤 *Nombre:* ${k.userName}\n📱 *Número:* ${phone}\n🔑 *Key:* ${k.code}\n📋 *Tipo:* ${tipo}\n📅 *Plan:* ${k.days} días\n${em} *Estado:* ${dl > 0 ? 'Activa ✅' : 'Vencida ❌'}\n⏳ *Días restantes:* ${dl}\n📅 *Vence:* ${new Date(k.expiry).toLocaleDateString('es-MX')}\n\n🌐 *Panel:* slimbot-premium.onrender.com\n🤖 *Versión:* SlimBot v2.0\n${dl <= 3 && dl > 0 ? '\n⚠️ _Tu licencia vence pronto._\n🌐 Renueva en: slimbot-premium.onrender.com' : ''}`;
  },

  // DESCARGAS GRATIS
  '.play': async (sock, msg, args, phone) => { if (!hasAccess(phone)) return NO_ACCESS; if (!args) return '🎵 *Uso:* .play [canción o url]'; return `🎵 *Buscando en YouTube...*\n🔍 ${args}`; },
  '.mp3': async (sock, msg, args, phone) => CMDS['.play'](sock, msg, args, phone),
  '.play2': async (sock, msg, args, phone) => { if (!hasAccess(phone)) return NO_ACCESS; if (!args) return '🎬 *Uso:* .play2 [video o url]'; return `🎬 *Descargando de YouTube...*\n🔍 ${args}`; },
  '.mp4': async (sock, msg, args, phone) => CMDS['.play2'](sock, msg, args, phone),
  '.spotify': async (sock, msg, args, phone) => { if (!hasAccess(phone)) return NO_ACCESS; if (!args) return '🎧 *Uso:* .spotify [canción]'; return `🎧 *Buscando en Spotify...*\n🔍 ${args}`; },
  '.sp': async (sock, msg, args, phone) => CMDS['.spotify'](sock, msg, args, phone),

  // DESCARGAS DELUXE
  '.facebook': async (sock, msg, args, phone) => { if (!hasAccess(phone)) return NO_ACCESS; if (!hasDeluxe(phone)) return DELUXE_ONLY; if (!args) return '📥 *Uso:* .facebook [url]'; return `📥 *Descargando de Facebook...*\n🔗 ${args}`; },
  '.fb': async (sock, msg, args, phone) => CMDS['.facebook'](sock, msg, args, phone),
  '.tiktok': async (sock, msg, args, phone) => { if (!hasAccess(phone)) return NO_ACCESS; if (!hasDeluxe(phone)) return DELUXE_ONLY; if (!args) return '📥 *Uso:* .tiktok [url]'; return `📥 *Descargando de TikTok...*\n🔍 ${args}`; },
  '.tt': async (sock, msg, args, phone) => CMDS['.tiktok'](sock, msg, args, phone),
  '.instagram': async (sock, msg, args, phone) => { if (!hasAccess(phone)) return NO_ACCESS; if (!hasDeluxe(phone)) return DELUXE_ONLY; if (!args) return '📥 *Uso:* .instagram [url]'; return `📥 *Descargando de Instagram...*\n🔗 ${args}`; },
  '.ig': async (sock, msg, args, phone) => CMDS['.instagram'](sock, msg, args, phone),

  // IA
  '.ia': async (sock, msg, args, phone) => { if (!hasAccess(phone)) return NO_ACCESS; if (!args) return '🤖 *Uso:* .ia [pregunta]'; return `🤖 *SlimBot IA*\n\n❓ ${args}\n\n💡 _Respuesta en camino..._`; },
  '.chatgpt': async (sock, msg, args, phone) => CMDS['.ia'](sock, msg, args, phone),

  // ANIME DELUXE
  '.hug': async (sock, msg, args, phone) => { if (!hasAccess(phone)) return NO_ACCESS; if (!hasDeluxe(phone)) return DELUXE_ONLY; return '🤗 *¡Abrazo anime!*\n_[GIF]_'; },
  '.kiss': async (sock, msg, args, phone) => { if (!hasAccess(phone)) return NO_ACCESS; if (!hasDeluxe(phone)) return DELUXE_ONLY; return '😘 *¡Beso anime!*\n_[GIF]_'; },
  '.slap': async (sock, msg, args, phone) => { if (!hasAccess(phone)) return NO_ACCESS; if (!hasDeluxe(phone)) return DELUXE_ONLY; return '👋 *¡Bofetada anime!*\n_[GIF]_'; },
  '.pat': async (sock, msg, args, phone) => { if (!hasAccess(phone)) return NO_ACCESS; if (!hasDeluxe(phone)) return DELUXE_ONLY; return '🤚 *Caricia anime*\n_[GIF]_'; },
  '.dance': async (sock, msg, args, phone) => { if (!hasAccess(phone)) return NO_ACCESS; if (!hasDeluxe(phone)) return DELUXE_ONLY; return '💃 *¡Bailando anime!*\n_[GIF]_'; },
  '.cry': async (sock, msg, args, phone) => { if (!hasAccess(phone)) return NO_ACCESS; if (!hasDeluxe(phone)) return DELUXE_ONLY; return '😭 *Llorando anime*\n_[GIF]_'; },
  '.blush': async (sock, msg, args, phone) => { if (!hasAccess(phone)) return NO_ACCESS; if (!hasDeluxe(phone)) return DELUXE_ONLY; return '😳 *Sonrojado*\n_[GIF]_'; },
  '.cuddle': async (sock, msg, args, phone) => { if (!hasAccess(phone)) return NO_ACCESS; if (!hasDeluxe(phone)) return DELUXE_ONLY; return '🥰 *Acurrucándose*\n_[GIF]_'; },
  '.punch': async (sock, msg, args, phone) => { if (!hasAccess(phone)) return NO_ACCESS; if (!hasDeluxe(phone)) return DELUXE_ONLY; return '👊 *¡Puñetazo!*\n_[GIF]_'; },
  '.happy': async (sock, msg, args, phone) => { if (!hasAccess(phone)) return NO_ACCESS; if (!hasDeluxe(phone)) return DELUXE_ONLY; return '🎉 *¡Feliz!*\n_[GIF]_'; },
  '.lick': async (sock, msg, args, phone) => { if (!hasAccess(phone)) return NO_ACCESS; if (!hasDeluxe(phone)) return DELUXE_ONLY; return '👅 *Lamiendo*\n_[GIF]_'; },
  '.wave': async (sock, msg, args, phone) => { if (!hasAccess(phone)) return NO_ACCESS; if (!hasDeluxe(phone)) return DELUXE_ONLY; return '👋 *¡Hola!*\n_[GIF]_'; },
  '.bite': async (sock, msg, args, phone) => { if (!hasAccess(phone)) return NO_ACCESS; if (!hasDeluxe(phone)) return DELUXE_ONLY; return '😤 *¡Mordida!*\n_[GIF]_'; },

  // ECONOMÍA
  '.balance': async (sock, msg, args, phone) => { if (!hasAccess(phone)) return NO_ACCESS; return '💰 *Tu balance:*\n🪙 Monedas: 0\n🏦 Banco: 0'; },
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
    return `🎰 [ ${r.join(' | ')} ]\n\n${r[0]===r[1]&&r[1]===r[2]?'🎉 ¡GANASTE el doble!':'❌ Perdiste. Suerte la próxima.'}`;
  },

  // BUSCAR DELUXE
  '.imagen': async (sock, msg, args, phone) => { if (!hasAccess(phone)) return NO_ACCESS; if (!hasDeluxe(phone)) return DELUXE_ONLY; if (!args) return '🔍 *Uso:* .imagen [búsqueda]'; return `🔍 *Buscando imágenes:* ${args}`; },
  '.img': async (sock, msg, args, phone) => CMDS['.imagen'](sock, msg, args, phone),
  '.wikipedia': async (sock, msg, args, phone) => { if (!hasAccess(phone)) return NO_ACCESS; if (!hasDeluxe(phone)) return DELUXE_ONLY; if (!args) return '📖 *Uso:* .wikipedia [tema]'; return `📖 *Wikipedia:* ${args}`; },
  '.wiki': async (sock, msg, args, phone) => CMDS['.wikipedia'](sock, msg, args, phone),
  '.pinterest': async (sock, msg, args, phone) => { if (!hasAccess(phone)) return NO_ACCESS; if (!hasDeluxe(phone)) return DELUXE_ONLY; if (!args) return '📌 *Uso:* .pinterest [búsqueda]'; return `📌 *Pinterest:* ${args}`; },
  '.pin': async (sock, msg, args, phone) => CMDS['.pinterest'](sock, msg, args, phone),

  // UTILS
  '.sticker': async (sock, msg, args, phone) => { if (!hasAccess(phone)) return NO_ACCESS; return '🎨 Responde a una imagen con *.sticker* para convertirla en sticker.'; },
  '.s': async (sock, msg, args, phone) => CMDS['.sticker'](sock, msg, args, phone),
  '.removebg': async (sock, msg, args, phone) => { if (!hasAccess(phone)) return NO_ACCESS; return '✂️ Responde a una imagen con *.removebg*'; },
  '.hd': async (sock, msg, args, phone) => { if (!hasAccess(phone)) return NO_ACCESS; return '🖼️ Responde a una imagen con *.hd*'; },
  '.ping': async (sock, msg, args, phone) => { const ms = Math.floor(Math.random()*80)+10; return `🏓 *Pong!* ⚡ ${ms}ms\n🟢 SlimBot activo`; },
  '.p': async (sock, msg, args, phone) => CMDS['.ping'](sock, msg, args, phone),

  // NSFW DELUXE
  '.xnxx': async (sock, msg, args, phone) => { if (!hasAccess(phone)) return NO_ACCESS; if (!hasDeluxe(phone)) return DELUXE_ONLY; if (!args) return '🔞 *Uso:* .xnxx [búsqueda]'; return `🔞 *XNXX:* ${args}`; },
  '.x
