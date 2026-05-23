const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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

function loadKeys() { init(); return JSON.parse(fs.readFileSync(KEYS_F, 'utf8')); }
function saveKeys(d) { fs.writeFileSync(KEYS_F, JSON.stringify(d, null, 2)); }
function loadUsers() { init(); return JSON.parse(fs.readFileSync(USERS_F, 'utf8')); }
function saveUsers(d) { fs.writeFileSync(USERS_F, JSON.stringify(d, null, 2)); }
function loadAdmin() { init(); return JSON.parse(fs.readFileSync(ADMIN_F, 'utf8')); }
function hashStr(str) { return crypto.createHash('sha256').update(str).digest('hex'); }

function genKey(type) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 8; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return type === 'deluxe' ? 'Lic-deluxe-' + s : 'Lic-slim-' + s;
}

function isValid(k) { return k && new Date(k.expiry) > new Date(); }
function daysLeft(k) { return Math.max(0, Math.ceil((new Date(k.expiry) - new Date()) / 86400000)); }

const PLANS = {
  normal: { '1': 1, '7': 5, '15': 10, '30': 15, '60': 20 },
  deluxe: { '1': 0.5, '7': 3, '15': 6, '30': 10, '60': 15 }
};

// AUTH
app.post('/api/register', (req, res) => {
  const { name, email, apodo, pass } = req.body;
  if (!name || !email || !apodo || !pass) return res.status(400).json({ ok: false, error: 'Todos los campos son requeridos' });
  const d = loadUsers();
  if (d.users.find(u => u.email === email.toLowerCase())) return res.status(400).json({ ok: false, error: 'El correo ya esta registrado' });
  if (d.users.find(u => u.apodo.toLowerCase() === apodo.toLowerCase())) return res.status(400).json({ ok: false, error: 'El apodo ya esta en uso' });
  const user = { id: Date.now().toString(), name, email: email.toLowerCase(), apodo, pass: hashStr(pass), saldo: 0, created: new Date().toISOString() };
  d.users.push(user);
  saveUsers(d);
  const { pass: _, ...safe } = user;
  res.json({ ok: true, user: safe });
});

app.post('/api/login', (req, res) => {
  const { apodo, pass } = req.body;
  if (!apodo || !pass) return res.status(400).json({ ok: false, error: 'Ingresa tu apodo y contrasena' });
  const d = loadUsers();
  const user = d.users.find(u => (u.apodo.toLowerCase() === apodo.toLowerCase() || u.email === apodo.toLowerCase()) && u.pass === hashStr(pass));
  if (!user) return res.status(401).json({ ok: false, error: 'Apodo o contrasena incorrectos' });
  const { pass: _, ...safe } = user;
  res.json({ ok: true, user: safe });
});

app.post('/api/admin/login', (req, res) => {
  const { user, pass } = req.body;
  const a = loadAdmin();
  if (user === a.user && pass === a.pass) res.json({ ok: true });
  else res.status(401).json({ ok: false, error: 'Credenciales incorrectas' });
});

// COMPRAR
app.post('/api/buy', (req, res) => {
  const { userId, tipo, dias } = req.body;
  if (!userId || !tipo || !dias) return res.status(400).json({ ok: false, error: 'Datos incompletos' });
  const precio = PLANS[tipo] && PLANS[tipo][dias];
  if (!precio) return res.status(400).json({ ok: false, error: 'Plan invalido' });
  const ud = loadUsers();
  const user = ud.users.find(u => u.id === userId);
  if (!user) return res.status(404).json({ ok: false, error: 'Usuario no encontrado' });
  if (user.saldo < precio) return res.status(400).json({ ok: false, error: 'Saldo insuficiente. Necesitas $' + precio + ', tienes $' + user.saldo });
  user.saldo = parseFloat((user.saldo - precio).toFixed(2));
  saveUsers(ud);
  const code = genKey(tipo);
  const now = new Date();
  const expiry = new Date(now.getTime() + parseInt(dias) * 86400000);
  const kd = loadKeys();
  const newKey = { code, userId, userName: user.name, type: tipo, days: parseInt(dias), created: now.toISOString(), expiry: expiry.toISOString(), phone: '' };
  kd.keys.push(newKey);
  saveKeys(kd);
  res.json({ ok: true, key: newKey, saldoRestante: user.saldo });
});

app.post('/api/mis-keys', (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ ok: false });
  const kd = loadKeys();
  const keys = kd.keys.filter(k => k.userId === userId).map(k => Object.assign({}, k, { daysLeft: daysLeft(k), active: isValid(k) }));
  res.json({ ok: true, keys });
});

// ADMIN
app.post('/api/admin/users', (req, res) => {
  const { user, pass } = req.body;
  const a = loadAdmin();
  if (user !== a.user || pass !== a.pass) return res.status(401).json({ ok: false });
  const d = loadUsers();
  res.json({ ok: true, users: d.users.map(u => { const { pass: _, ...s } = u; return s; }) });
});

app.post('/api/admin/saldo', (req, res) => {
  const { user, pass, userId, monto } = req.body;
  const a = loadAdmin();
  if (user !== a.user || pass !== a.pass) return res.status(401).json({ ok: false });
  const d = loadUsers();
  const u = d.users.find(x => x.id === userId);
  if (!u) return res.status(404).json({ ok: false, error: 'Usuario no encontrado' });
  u.saldo = parseFloat((u.saldo + parseFloat(monto)).toFixed(2));
  saveUsers(d);
  res.json({ ok: true, saldo: u.saldo });
});

app.post('/api/admin/keys', (req, res) => {
  const { user, pass } = req.body;
  const a = loadAdmin();
  if (user !== a.user || pass !== a.pass) return res.status(401).json({ ok: false });
  const kd = loadKeys();
  res.json({ ok: true, keys: kd.keys.map(k => Object.assign({}, k, { daysLeft: daysLeft(k), active: isValid(k) })) });
});

app.post('/api/admin/genkey', (req, res) => {
  const { user, pass, name, tipo, dias } = req.body;
  const a = loadAdmin();
  if (user !== a.user || pass !== a.pass) return res.status(401).json({ ok: false });
  const code = genKey(tipo || 'normal');
  const now = new Date();
  const expiry = new Date(now.getTime() + parseInt(dias) * 86400000);
  const kd = loadKeys();
  const newKey = { code, userId: null, userName: name, type: tipo || 'normal', days: parseInt(dias), created: now.toISOString(), expiry: expiry.toISOString(), phone: '' };
  kd.keys.push(newKey);
  saveKeys(kd);
  res.json({ ok: true, key: newKey });
});

app.post('/api/admin/delkey', (req, res) => {
  const { user, pass, code } = req.body;
  const a = loadAdmin();
  if (user !== a.user || pass !== a.pass) return res.status(401).json({ ok: false });
  const kd = loadKeys();
  kd.keys = kd.keys.filter(k => k.code !== code);
  saveKeys(kd);
  res.json({ ok: true });
});

let currentQR = null, botConnected = false;
app.get('/api/bot/status', (req, res) => res.json({ connected: botConnected, hasQR: !!currentQR }));
app.get('/api/bot/qr', async (req, res) => {
  if (!currentQR) return res.status(404).json({ ok: false });
  try {
    const QRCode = require('qrcode');
    const q = await QRCode.toDataURL(currentQR);
    res.json({ ok: true, qr: q });
  } catch (e) { res.status(500).json({ ok: false }); }
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// BOT
async function startBot() {
  try {
    const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
    const { Boom } = require('@hapi/boom');
    const { state, saveCreds } = await useMultiFileAuthState('./auth_slimbot');
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({ version, auth: state, printQRInTerminal: false, browser: ['SlimBot', 'Chrome', '2.0.0'] });
    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', function(update) {
      const connection = update.connection;
      const lastDisconnect = update.lastDisconnect;
      const qr = update.qr;
      if (qr) { currentQR = qr; botConnected = false; console.log('QR listo'); }
      if (connection === 'close') {
        botConnected = false; currentQR = null;
        const code = lastDisconnect && lastDisconnect.error ? lastDisconnect.error.output && lastDisconnect.error.output.statusCode : null;
        if (code !== DisconnectReason.loggedOut) setTimeout(startBot, 3000);
      } else if (connection === 'open') {
        botConnected = true; currentQR = null;
        console.log('SlimBot conectado!');
      }
    });

    sock.ev.on('messages.upsert', async function(upsert) {
      const messages = upsert.messages;
      const type = upsert.type;
      if (type !== 'notify') return;
      for (const msg of messages) {
        if (!msg.message || msg.key.fromMe) continue;
        const phone = msg.key.remoteJid.replace('@s.whatsapp.net', '').replace('@g.us', '');
        const body = (msg.message.conversation || (msg.message.extendedTextMessage && msg.message.extendedTextMessage.text) || '').trim();
        if (!body.startsWith('.')) continue;
        const parts = body.split(' ');
        const cmd = parts[0].toLowerCase();
        const args = parts.slice(1).join(' ') || null;
        let response = null;

        function hasAccess() {
          const kd = loadKeys();
          return kd.keys.some(k => k.phone === phone && isValid(k));
        }
        function hasDeluxe() {
          const kd = loadKeys();
          return kd.keys.some(k => k.phone === phone && isValid(k) && k.type === 'deluxe');
        }
        function getUserKey() {
          const kd = loadKeys();
          return kd.keys.find(k => k.phone === phone && isValid(k)) || null;
        }

        const NO_ACCESS = 'Acceso requerido\n\nActiva tu licencia:\n.key Lic-slim-XXXXXXXX\n\nCompra en:\nslimbot-premium.onrender.com';
        const DELUXE_ONLY = 'Funcion exclusiva KEY Deluxe\n\nActualiza a Deluxe para acceder.\nslimbot-premium.onrender.com';

        if (cmd === '.key') {
          if (!args) { response = 'Uso: .key Lic-slim-XXXXXXXX'; }
          else {
            const code = args.trim();
            if (!code.toLowerCase().startsWith('lic-slim-') && !code.toLowerCase().startsWith('lic-deluxe-')) {
              response = 'Formato incorrecto.\nUsa: Lic-slim-XXXXXXXX o Lic-deluxe-XXXXXXXX';
            } else {
              const kd = loadKeys();
              const k = kd.keys.find(x => x.code.toLowerCase() === code.toLowerCase());
              if (!k) response = 'Key no encontrada.\n\nCompra en: slimbot-premium.onrender.com';
              else if (!isValid(k)) response = 'Licencia vencida.\n\nRenueva en: slimbot-premium.onrender.com';
              else {
                const dbKey = kd.keys.find(x => x.code.toLowerCase() === code.toLowerCase());
                if (dbKey) { dbKey.phone = phone; saveKeys(kd); }
                const tipo = k.type === 'deluxe' ? 'KEY Deluxe' : 'KEY Normal';
                response = 'Licencia activada!\n\nCliente: ' + k.userName + '\nTipo: ' + tipo + '\nDias restantes: ' + daysLeft(k) + '\n\nEscribe .menu para ver tus comandos.';
              }
            }
          }
        } else if (cmd === '.menu') {
          if (!hasAccess()) response = NO_ACCESS;
          else {
            const d = hasDeluxe();
            response = 'SlimBot Premium\n\nLICENCIA\n.key .info .menu\n\nDESCARGAS GRATIS\n.play .mp3 YouTube audio\n.play2 .mp4 YouTube video\n.spotify\n\nDESCARGAS DELUXE ' + (d ? '[Tienes acceso]' : '[Requiere Deluxe]') + '\n.facebook .fb\n.tiktok .tt\n.instagram .ig\n\nIA\n.ia .chatgpt\n\nANIME DELUXE ' + (d ? '[Tienes acceso]' : '[Requiere Deluxe]') + '\n.hug .kiss .slap .pat .dance .cry\n\nECONOMIA\n.balance .daily .work .slot\n\nBUSCAR DELUXE ' + (d ? '[Tienes acceso]' : '[Requiere Deluxe]') + '\n.imagen .wikipedia .pinterest\n\nUTILS\n.sticker .ping\n\nNSFW DELUXE ' + (d ? '[Tienes acceso]' : '[Requiere Deluxe]') + '\n.xnxx .xvideos\n\nREDES\n.redes\n\nSlimBot v2.0';
          }
        } else if (cmd === '.info') {
          if (!hasAccess()) response = NO_ACCESS;
          else {
            const k = getUserKey();
            const dl = daysLeft(k);
            const tipo = k.type === 'deluxe' ? 'KEY Deluxe' : 'KEY Normal';
            const estado = dl > 0 ? 'Activa' : 'Vencida';
            response = 'Informacion de Licencia\n\nNombre: ' + k.userName + '\nNumero: ' + phone + '\nKey: ' + k.code + '\nTipo: ' + tipo + '\nPlan: ' + k.days + ' dias\nEstado: ' + estado + '\nDias restantes: ' + dl + '\nVence: ' + new Date(k.expiry).toLocaleDateString('es-MX') + '\n\nPanel: slimbot-premium.onrender.com\nVersion: SlimBot v2.0';
          }
        } else if (cmd === '.play' || cmd === '.mp3') {
          if (!hasAccess()) response = NO_ACCESS;
          else if (!args) response = 'Uso: .play [cancion o url]';
          else response = 'Buscando en YouTube...\n' + args;
        } else if (cmd === '.play2' || cmd === '.mp4') {
          if (!hasAccess()) response = NO_ACCESS;
          else if (!args) response = 'Uso: .play2 [video o url]';
          else response = 'Descargando de YouTube...\n' + args;
        } else if (cmd === '.spotify' || cmd === '.sp') {
          if (!hasAccess()) response = NO_ACCESS;
          else if (!args) response = 'Uso: .spotify [cancion]';
          else response = 'Buscando en Spotify...\n' + args;
        } else if (cmd === '.facebook' || cmd === '.fb') {
          if (!hasAccess()) response = NO_ACCESS;
          else if (!hasDeluxe()) response = DELUXE_ONLY;
          else if (!args) response = 'Uso: .facebook [url]';
          else response = 'Descargando de Facebook...\n' + args;
        } else if (cmd === '.tiktok' || cmd === '.tt') {
          if (!hasAccess()) response = NO_ACCESS;
          else if (!hasDeluxe()) response = DELUXE_ONLY;
          else if (!args) response = 'Uso: .tiktok [url]';
          else response = 'Descargando de TikTok...\n' + args;
        } else if (cmd === '.instagram' || cmd === '.ig' || cmd === '.reel') {
          if (!hasAccess()) response = NO_ACCESS;
          else if (!hasDeluxe()) response = DELUXE_ONLY;
          else if (!args) response = 'Uso: .instagram [url]';
          else response = 'Descargando de Instagram...\n' + args;
        } else if (cmd === '.ia' || cmd === '.chatgpt') {
          if (!hasAccess()) response = NO_ACCESS;
          else if (!args) response = 'Uso: .ia [pregunta]';
          else response = 'SlimBot IA\n\nPregunta: ' + args + '\n\nConecta tu API de OpenAI para respuestas reales.';
        } else if (['.hug','.kiss','.slap','.pat','.dance','.cry','.blush','.cuddle','.punch','.happy','.lick','.wave','.bite'].includes(cmd)) {
          if (!hasAccess()) response = NO_ACCESS;
          else if (!hasDeluxe()) response = DELUXE_ONLY;
          else response = cmd.replace('.','') + ' [GIF anime - conecta API de GIFs]';
        } else if (cmd === '.balance' || cmd === '.bal') {
          if (!hasAccess()) response = NO_ACCESS;
          else response = 'Tu balance:\nMonedas: 0\nBanco: 0';
        } else if (cmd === '.daily') {
          if (!hasAccess()) response = NO_ACCESS;
          else response = 'Recompensa diaria!\n+100 monedas';
        } else if (cmd === '.work' || cmd === '.w') {
          if (!hasAccess()) response = NO_ACCESS;
          else {
            const jobs = ['programador','chef','mecanico','maestro','doctor'];
            const coins = Math.floor(Math.random()*50)+20;
            response = 'Trabajo completado!\nTrabajaste como ' + jobs[Math.floor(Math.random()*jobs.length)] + '\n+' + coins + ' monedas';
          }
        } else if (cmd === '.slot') {
          if (!hasAccess()) response = NO_ACCESS;
          else if (!args) response = 'Uso: .slot [cantidad]';
          else {
            const items = ['cherry','lemon','grape','star','7'];
            const r = [items[Math.floor(Math.random()*items.length)], items[Math.floor(Math.random()*items.length)], items[Math.floor(Math.random()*items.length)]];
            response = 'Casino: [ ' + r.join(' | ') + ' ]\n' + (r[0]===r[1]&&r[1]===r[2] ? 'GANASTE el doble!' : 'Perdiste. Suerte la proxima.');
          }
        } else if (cmd === '.imagen' || cmd === '.img') {
          if (!hasAccess()) response = NO_ACCESS;
          else if (!hasDeluxe()) response = DELUXE_ONLY;
          else if (!args) response = 'Uso: .imagen [busqueda]';
          else response = 'Buscando imagenes: ' + args;
        } else if (cmd === '.wikipedia' || cmd === '.wiki') {
          if (!hasAccess()) response = NO_ACCESS;
          else if (!hasDeluxe()) response = DELUXE_ONLY;
          else if (!args) response = 'Uso: .wikipedia [tema]';
          else response = 'Wikipedia: ' + args;
        } else if (cmd === '.pinterest' || cmd === '.pin') {
          if (!hasAccess()) response = NO_ACCESS;
          else if (!hasDeluxe()) response = DELUXE_ONLY;
          else if (!args) response = 'Uso: .pinterest [busqueda]';
          else response = 'Pinterest: ' + args;
        } else if (cmd === '.sticker' || cmd === '.s') {
          if (!hasAccess()) response = NO_ACCESS;
          else response = 'Responde a una imagen con .sticker para convertirla en sticker.';
        } else if (cmd === '.ping' || cmd === '.p') {
          const ms = Math.floor(Math.random()*80)+10;
          response = 'Pong! ' + ms + 'ms - SlimBot activo';
        } else if (cmd === '.xnxx') {
          if (!hasAccess()) response = NO_ACCESS;
          else if (!hasDeluxe()) response = DELUXE_ONLY;
          else if (!args) response = 'Uso: .xnxx [busqueda]';
          else response = 'XNXX: ' + args;
        } else if (cmd === '.xvideos') {
          if (!hasAccess()) response = NO_ACCESS;
          else if (!hasDeluxe()) response = DELUXE_ONLY;
          else if (!args) response = 'Uso: .xvideos [busqueda]';
          else response = 'XVideos: ' + args;
        } else if (cmd === '.redes') {
          response = 'Redes y Contacto\n\nWhatsApp Admin:\n+52 612 169 79 59\n\nPanel web:\nslimbot-premium.onrender.com';
        } else {
          if (hasAccess()) response = 'Comando desconocido: ' + cmd + '\nEscribe .menu para ver los comandos.';
        }

        if (response) {
          try { await sock.sendMessage(msg.key.remoteJid, { text: response }, { quoted: msg }); }
          catch(e) { console.error('Error enviando:', e.message); }
        }
      }
    });
  } catch(e) {
    console.error('Error iniciando bot:', e.message);
    setTimeout(startBot, 5000);
  }
}

app.listen(PORT, function() { console.log('Servidor en puerto ' + PORT); });
startBot();
