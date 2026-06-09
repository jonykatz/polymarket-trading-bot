# Guía rápida — Bot en DigitalOcean Droplet

Cheat sheet para conectarte, revisar estado, logs y actualizar el bot cuando lo necesites.

---

## Datos del servidor

| Campo | Valor |
|-------|--------|
| IP | `188.166.4.44` |
| Usuario SSH | `root` |
| Hostname | `polymarket-bot` |
| Carpeta del bot | `/root/polymarket-trading-bot` |
| Proceso PM2 | `polymarket-bot` |

---

## 1. Conectarte (desde tu Mac)

Abrí **Terminal en macOS** (no dentro del droplet):

```bash
ssh root@188.166.4.44
```

Salir del droplet:

```bash
exit
```

> Si pide contraseña, usá la de root del droplet o tu clave SSH configurada en DigitalOcean.

---

## 2. ¿El bot está corriendo?

En el droplet:

```bash
cd ~/polymarket-trading-bot
npm run pm2:status
```

| `status` | Significado |
|----------|-------------|
| `online` | Todo bien |
| `stopped` | Parado — ver sección Reiniciar |
| `errored` | Falló — ver Logs |

---

## 3. Logs (sin dejar terminal abierta)

PM2 **guarda solo** en disco. No hace falta `pm2:logs` 24/7.

### Ver últimas líneas

```bash
cd ~/polymarket-trading-bot
tail -50 logs/pm2-out.log
tail -30 logs/pm2-error.log
```

### Ver en vivo (opcional)

```bash
npm run pm2:logs
```

Salir: **Ctrl+C** (el bot sigue corriendo).

### Desde tu Mac (sin entrar al droplet)

```bash
ssh root@188.166.4.44 "tail -50 /root/polymarket-trading-bot/logs/pm2-out.log"
```

---

## 4. Monitoreo sin logs

Los eventos importantes van a **n8n → Sheets** (`WEBHOOK_URL` en `.env`):

- `SIGNAL_SKIP`, `ENTRY_FAK_FAILED`, `EXIT_SKIP`
- `OPEN` / compras / `TRADE_CLOSED_*`

Revisá Sheets cuando quieras ver actividad sin SSH.

---

## 5. Comandos del día a día (en el droplet)

```bash
cd ~/polymarket-trading-bot

npm run pm2:status    # ¿está vivo?
npm run pm2:logs      # tail en vivo
npm run pm2:stop      # parar bot
npm run pm2:restart   # rebuild + reiniciar
npm run pm2:deploy    # rebuild + reiniciar + logs
```

---

## 6. Actualizar código después de un `git push`

En el droplet:

```bash
cd ~/polymarket-trading-bot
git pull origin dev
npm run pm2:deploy
```

O en un solo SSH desde Mac:

```bash
ssh root@188.166.4.44 "cd /root/polymarket-trading-bot && git pull origin dev && npm run pm2:deploy"
```

---

## 7. Cambiar configuración (`.env`)

**Nunca** subas `.env` a GitHub.

### Copiar `.env` desde tu Mac

```bash
cd /Users/jonathankatz/Downloads/GitHub/openclaw-ai-polymarket-trading-bot-own
scp .env root@188.166.4.44:/root/polymarket-trading-bot/.env
```

### Aplicar cambios

```bash
ssh root@188.166.4.44 "cd /root/polymarket-trading-bot && npm run pm2:restart"
```

---

## 8. Probar wallet / CLOB

En el droplet:

```bash
cd ~/polymarket-trading-bot
npm run clob:balance
npm run clob:verify
```

---

## 9. Reiniciar el droplet entero

DigitalOcean panel → Droplet → **Power** → Reboot.

El bot debería volver solo (`pm2 startup` + `pm2 save` ya configurados).

Comprobar después:

```bash
ssh root@188.166.4.44 "cd /root/polymarket-trading-bot && npm run pm2:status"
```

---

## 10. Regla de oro: un solo bot

Solo **una** instancia debe operar con la misma wallet:

| Dónde | Qué hacer |
|-------|-----------|
| Droplet | `npm run pm2:start` (producción) |
| Mac local | `npm run pm2:stop` |
| Railway | Pausado / apagado |

Dos bots a la vez = órdenes duplicadas y pérdidas.

---

## 11. Problemas frecuentes

### No puedo conectar por SSH

- Droplet encendido en panel DO (verde)
- Esperá 1 min tras un reboot
- Consola web: DO → Access → **Launch Droplet Console**

### Bot `errored` en PM2

```bash
cd ~/polymarket-trading-bot
tail -50 logs/pm2-error.log
npm run pm2:restart
```

### Falta `.env`

```bash
ls -la /root/polymarket-trading-bot/.env
```

Si no existe, copiá desde Mac (sección 7).

---

## 12. Acceso rápido — copiar y pegar

```bash
# Entrar al servidor
ssh root@188.166.4.44

# Una vez dentro
cd ~/polymarket-trading-bot && npm run pm2:status && tail -30 logs/pm2-out.log
```
