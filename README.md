# Talon — Backend

API REST pentru aplicația mobilă Talon (urmărirea documentelor, cheltuielilor
și combustibilului pentru vehicule + administrarea locuințelor, facturilor și
bugetelor pentru gospodării).

## Stack

- **Node.js** + **Express** — server HTTP
- **Prisma** (PostgreSQL) — ORM + migrații
- **JWT** — autentificare, cu refresh tokens
- **Tesseract** (`*.traineddata` în repo) — OCR pentru taloane și facturi
- **Groq SDK** — asistent AI (Llama 3.3 70B)

## Rulare locală

```bash
# 1) Variabile de mediu
cp .env.example .env
# completează DATABASE_URL, DIRECT_URL, JWT_SECRET, JWT_REFRESH_SECRET, GROQ_API_KEY

# 2) Instalare
npm install

# 3) Migrații (creează schema în baza ta de date)
npm run db:migrate

# 4) Pornește serverul
npm start
# implicit pe http://0.0.0.0:3002 — health check la /api/health
```

## Structură

```
src/
  routes/         # endpoints REST grupate pe domeniu
  middleware/     # auth (JWT), audit log
  utils/          # access control, push notifications, sync
  prisma.js       # singleton Prisma client
  server.js       # bootstrap Express
prisma/
  schema.prisma   # modelul de date
  migrations/     # istoricul migrațiilor (rulează cu prisma migrate)
```

## API

- `POST /api/auth/{register,login,refresh}` — autentificare
- `GET/POST/PUT/DELETE /api/{vehicles,documents,invoices,reminders,fuel}` — modulul auto
- `GET/POST/PUT/DELETE /api/households/...` — modulul locuință (cheltuieli, venituri, evenimente, facturi recurente, bugete)
- `POST /api/chats/:friendId/messages` — chat 1:1 între prieteni
- `POST /api/ai/chat` — asistentul AI (modes: `vehicle`, `household`)
- `POST /api/ocr` — extragere date din imagini de talon / facturi

Toate rutele (în afară de auth) cer header `Authorization: Bearer <token>`.

## Notă de securitate

- `.env` **nu** este în repo. Generează JWT secrets puternice pentru producție
  (`openssl rand -base64 32`).
- Endpoint-urile verifică accesul per resursă (vehicule prin `VehicleMember`,
  locuințe prin `HouseholdMember`) — un user nu poate accesa date care nu sunt
  ale lui sau partajate cu el.
- Refresh tokens sunt stocate în DB și pot fi invalidate la logout.
