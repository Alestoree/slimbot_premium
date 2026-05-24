# SlimBot Premium VIP

Bot de WhatsApp de paga con sistema de keys y panel web.

## Archivos

```
slimbot-railway/
├── server.js          ← Bot + API + Servidor web (todo en uno)
├── package.json       ← Dependencias
├── public/
│   └── index.html     ← Panel web (ventas + admin + usuario)
└── data/              ← Se crea automático (keys.json, admin.json)
```

## Subir a Railway

1. Sube esta carpeta a GitHub
2. Railway → New Project → Deploy from GitHub
3. Selecciona el repo
4. Railway despliega automático
5. Settings → Networking → Generate Domain
6. Ve a tu URL → Login Admin → QR Bot → Escanea con WhatsApp

## Credenciales por defecto

- Admin usuario: `admin`
- Admin contraseña: `slim2024`

## Flujo de keys

1. Admin genera key en el panel
2. Key se guarda en `data/keys.json` del servidor
3. Admin manda la key al cliente
4. Cliente escribe `.key Lic-slim-XXXXXXXX` en WhatsApp
5. Bot verifica → acceso VIP activado ✅
