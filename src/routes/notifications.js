const prisma = require('../prisma');
const express = require('express');

const { authMiddleware } = require('../middleware/auth');
const { sendPush } = require('../utils/push');

const router = express.Router();


router.use(authMiddleware);

// ── Register Expo push token ──────────────────────────────────────────────────
router.post('/register-token', async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'Token lipsă' });
  await prisma.user.update({ where: { id: req.user.id }, data: { pushToken: token } });
  res.json({ message: 'Token înregistrat' });
});

// ── Check upcoming reminders → create DB notifications + send pushes ─────────
router.post('/check-reminders', async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { pushToken: true },
    });

    const today = new Date();
    const in30 = new Date(today); in30.setDate(in30.getDate() + 30);
    const todayStr = today.toISOString().slice(0, 10);
    const in30Str  = in30.toISOString().slice(0, 10);

    const reminders = await prisma.reminder.findMany({
      where: {
        userId: req.user.id,
        isDone: false,
        dueDate: { gte: todayStr, lte: in30Str },
      },
    });

    const created = [];

    for (const r of reminders) {
      const daysLeft = Math.ceil((new Date(r.dueDate) - today) / 86400000);

      // Only notify at specific thresholds to avoid spam
      const shouldNotify = daysLeft <= 1 || daysLeft === 3 || daysLeft === 7 || daysLeft === 14 || daysLeft === 30;
      if (!shouldNotify) continue;

      // Check if we already sent this exact threshold notification
      const tag = `reminder:${r.id}:d${daysLeft}`;
      const existing = await prisma.notification.findFirst({
        where: { userId: req.user.id, relatedId: tag },
      });
      if (existing) continue;

      const urgency = daysLeft <= 1 ? 'urgent' : daysLeft <= 7 ? 'warning' : 'info';
      const daysLabel = daysLeft === 0 ? 'azi' : daysLeft === 1 ? 'mâine' : `în ${daysLeft} zile`;
      const title = `⏰ ${r.title}`;
      const body  = `Scadent ${daysLabel} (${r.dueDate})`;

      const notif = await prisma.notification.create({
        data: { userId: req.user.id, title, body, type: urgency, relatedId: tag, relatedType: 'reminder' },
      });
      created.push(notif);

      if (user?.pushToken && daysLeft <= 7) {
        await sendPush(user.pushToken, { title, body, data: { type: 'reminder', reminderId: r.id } });
      }
    }

    // Also check vehicle expiry dates (ITP, RCA, CASCO, Rovinieta)
    const vehicles = await prisma.vehicle.findMany({
      where: { userId: req.user.id },
      select: { id: true, plate: true, brand: true, model: true, itpDate: true, rcaDate: true, cascoDate: true, rovDate: true },
    });

    const expiryFields = [
      { key: 'itpDate',   label: 'ITP' },
      { key: 'rcaDate',   label: 'RCA' },
      { key: 'cascoDate', label: 'CASCO' },
      { key: 'rovDate',   label: 'Rovinieta' },
    ];

    for (const v of vehicles) {
      for (const { key, label } of expiryFields) {
        const expiry = v[key];
        if (!expiry) continue;

        const daysLeft = Math.ceil((new Date(expiry) - today) / 86400000);
        const shouldNotify = daysLeft <= 1 || daysLeft === 3 || daysLeft === 7 || daysLeft === 14 || daysLeft === 30;
        if (!shouldNotify) continue;

        const tag = `vehicle:${v.id}:${key}:d${daysLeft}`;
        const existing = await prisma.notification.findFirst({
          where: { userId: req.user.id, relatedId: tag },
        });
        if (existing) continue;

        const urgency = daysLeft <= 1 ? 'urgent' : daysLeft <= 7 ? 'warning' : 'info';
        const daysLabel = daysLeft <= 0 ? 'expirat' : daysLeft === 1 ? 'mâine' : `în ${daysLeft} zile`;
        const title = `🚗 ${label} — ${v.plate}`;
        const body  = `${label} expiră ${daysLabel} (${expiry})`;

        const notif = await prisma.notification.create({
          data: { userId: req.user.id, title, body, type: urgency, relatedId: tag, relatedType: 'vehicle' },
        });
        created.push(notif);

        if (user?.pushToken && daysLeft <= 7) {
          await sendPush(user.pushToken, { title, body, data: { type: 'vehicle', vehicleId: v.id } });
        }
      }
    }

    res.json({ created: created.length });
  } catch (e) {
    console.error('check-reminders error:', e);
    res.status(500).json({ error: 'Eroare server' });
  }
});

// ── List notifications ────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  const notifs = await prisma.notification.findMany({
    where: { userId: req.user.id },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
  res.json(notifs);
});

// ── Create notification (internal use + send push) ────────────────────────────
router.post('/', async (req, res) => {
  try {
    const { title, body, type, relatedId, relatedType } = req.body;
    if (!title || !body) return res.status(400).json({ error: 'Titlu și corp sunt obligatorii' });
    const notif = await prisma.notification.create({
      data: { userId: req.user.id, title, body, type: type || 'info', relatedId: relatedId || null, relatedType: relatedType || null },
    });
    const user = await prisma.user.findUnique({ where: { id: req.user.id }, select: { pushToken: true } });
    if (user?.pushToken) {
      await sendPush(user.pushToken, { title, body });
    }
    res.status(201).json(notif);
  } catch (e) {
    res.status(500).json({ error: 'Eroare server' });
  }
});

// ── Mark one as read ──────────────────────────────────────────────────────────
router.put('/read-all', async (req, res) => {
  await prisma.notification.updateMany({ where: { userId: req.user.id, isRead: false }, data: { isRead: true } });
  res.json({ message: 'Toate marcate ca citite' });
});

router.put('/:id/read', async (req, res) => {
  const n = await prisma.notification.findFirst({ where: { id: req.params.id, userId: req.user.id } });
  if (!n) return res.status(404).json({ error: 'Notificare negăsită' });
  await prisma.notification.update({ where: { id: req.params.id }, data: { isRead: true } });
  res.json({ message: 'Marcat ca citit' });
});

// ── Delete ────────────────────────────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  const n = await prisma.notification.findFirst({ where: { id: req.params.id, userId: req.user.id } });
  if (!n) return res.status(404).json({ error: 'Notificare negăsită' });
  await prisma.notification.delete({ where: { id: req.params.id } });
  res.json({ message: 'Notificare ștearsă' });
});

module.exports = router;
