const prisma = require('../prisma');
const express = require('express');

const { authMiddleware } = require('../middleware/auth');
const { audit } = require('../middleware/audit');
const { getVehicleAccess, accessibleVehicleIds } = require('../utils/vehicleAccess');

const router = express.Router();


router.use(authMiddleware);

router.get('/', async (req, res) => {
  try {
    const userId = req.user.id;
    const vehicleIds = await accessibleVehicleIds(userId);
    const reminders = await prisma.reminder.findMany({
      where: {
        OR: [
          { userId },
          { vehicleId: { in: vehicleIds } },
        ],
      },
      orderBy: { dueDate: 'asc' },
    });
    res.json(reminders);
  } catch (e) {
    res.status(500).json({ error: 'Eroare server' });
  }
});

router.post('/', async (req, res) => {
  try {
    const { clientId, vehicleId, title, dueDate, type, repeat, notes } = req.body;
    if (!title || !dueDate) return res.status(400).json({ error: 'Titlu și dată sunt obligatorii' });
    const normalizedClientId = clientId ? String(clientId) : null;
    if (normalizedClientId) {
      const existing = await prisma.reminder.findUnique({
        where: { userId_clientId: { userId: req.user.id, clientId: normalizedClientId } },
      });
      if (existing) return res.json(existing);
    }

    if (vehicleId) {
      const access = await getVehicleAccess(req.user.id, vehicleId);
      if (!access.ok) return res.status(access.status).json({ error: access.error });
    }

    const reminder = await prisma.reminder.create({
      data: { clientId: normalizedClientId, userId: req.user.id, vehicleId: vehicleId || null, title, dueDate, type: type || 'altele', repeat: repeat || 'none', notes: notes || null },
    });
    await audit(req.user.id, 'CREATE', 'Reminder', reminder.id, title, req.ip);
    res.status(201).json(reminder);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Eroare server' });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const r = await prisma.reminder.findUnique({ where: { id: req.params.id } });
    if (!r) return res.status(404).json({ error: 'Reminder negăsit' });

    // Access: owner of the reminder, OR (reminder is attached to vehicle and user has access)
    let allowed = r.userId === req.user.id;
    if (!allowed && r.vehicleId) {
      const access = await getVehicleAccess(req.user.id, r.vehicleId);
      allowed = access.ok;
    }
    if (!allowed) return res.status(403).json({ error: 'Acces interzis' });

    const { title, dueDate, type, repeat, notes, isDone } = req.body;
    const updated = await prisma.reminder.update({
      where: { id: req.params.id },
      data: { title: title || undefined, dueDate: dueDate || undefined, type: type || undefined, repeat: repeat || undefined, notes: notes !== undefined ? notes : undefined, isDone: isDone !== undefined ? isDone : undefined },
    });
    await audit(req.user.id, 'UPDATE', 'Reminder', updated.id, updated.title, req.ip);
    res.json(updated);
  } catch (e) {
    res.status(500).json({ error: 'Eroare server' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const r = await prisma.reminder.findUnique({ where: { id: req.params.id } });
    if (!r) return res.status(404).json({ error: 'Reminder negăsit' });

    let allowed = r.userId === req.user.id;
    if (!allowed && r.vehicleId) {
      const access = await getVehicleAccess(req.user.id, r.vehicleId);
      allowed = access.ok && access.role === 'owner';
    }
    if (!allowed) return res.status(403).json({ error: 'Acces interzis' });

    await prisma.reminder.delete({ where: { id: req.params.id } });
    await audit(req.user.id, 'DELETE', 'Reminder', req.params.id, r.title, req.ip);
    res.json({ message: 'Reminder șters' });
  } catch (e) {
    res.status(500).json({ error: 'Eroare server' });
  }
});

module.exports = router;
