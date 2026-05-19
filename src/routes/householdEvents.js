const express = require('express');
const prisma = require('../prisma');
const { authMiddleware } = require('../middleware/auth');
const { audit } = require('../middleware/audit');
const { auditInclude } = require('../utils/audit');
const { getHouseholdAccess, accessibleHouseholdIds } = require('../utils/householdAccess');

const router = express.Router();
router.use(authMiddleware);

router.get('/', async (req, res) => {
  try {
    const { householdId } = req.query;
    let allowedIds;
    if (householdId) {
      const access = await getHouseholdAccess(req.user.id, householdId);
      if (!access.ok) return res.status(access.status).json({ error: access.error });
      allowedIds = [householdId];
    } else {
      allowedIds = await accessibleHouseholdIds(req.user.id);
    }
    const items = await prisma.householdEvent.findMany({
      where: { householdId: { in: allowedIds } },
      orderBy: { startDate: 'asc' },
      include: auditInclude,
    });
    res.json(items);
  } catch (e) {
    res.status(500).json({ error: 'Eroare server' });
  }
});

router.post('/', async (req, res) => {
  try {
    const {
      clientId, householdId, title, type, startDate, startTime, endDate, endTime,
      location, notes, reminderMinutes,
    } = req.body;
    if (!householdId || !title || !startDate) {
      return res.status(400).json({ error: 'Locuință, titlu, dată sunt obligatorii' });
    }
    const normalizedClientId = clientId ? String(clientId) : null;
    if (normalizedClientId) {
      const existing = await prisma.householdEvent.findUnique({
        where: { userId_clientId: { userId: req.user.id, clientId: normalizedClientId } },
      });
      if (existing) return res.json(existing);
    }
    const access = await getHouseholdAccess(req.user.id, householdId);
    if (!access.ok) return res.status(access.status).json({ error: access.error });

    const ev = await prisma.householdEvent.create({
      data: {
        clientId: normalizedClientId,
        userId: req.user.id,
        householdId,
        title,
        type: type || 'altele',
        startDate,
        startTime: startTime || null,
        endDate: endDate || null,
        endTime: endTime || null,
        location: location || null,
        notes: notes || null,
        reminderMinutes: reminderMinutes ? parseInt(reminderMinutes) : null,
      },
    });
    await audit(req.user.id, 'CREATE', 'HouseholdEvent', ev.id, title, req.ip);
    res.status(201).json(ev);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Eroare server' });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const item = await prisma.householdEvent.findUnique({ where: { id: req.params.id } });
    if (!item) return res.status(404).json({ error: 'Inexistent' });
    const access = await getHouseholdAccess(req.user.id, item.householdId);
    if (!access.ok) return res.status(access.status).json({ error: access.error });
    if (access.role !== 'owner' && item.userId !== req.user.id) {
      // Membrii pot doar toggle isDone — verificăm doar isDone
      if (Object.keys(req.body).length !== 1 || !('isDone' in req.body)) {
        return res.status(403).json({ error: 'Poți edita doar evenimentele tale' });
      }
    }
    const {
      title, type, startDate, startTime, endDate, endTime,
      location, notes, isDone, reminderMinutes,
    } = req.body;
    const updated = await prisma.householdEvent.update({
      where: { id: req.params.id },
      data: {
        title: title || undefined,
        type: type || undefined,
        startDate: startDate || undefined,
        startTime: startTime !== undefined ? (startTime || null) : undefined,
        endDate: endDate !== undefined ? (endDate || null) : undefined,
        endTime: endTime !== undefined ? (endTime || null) : undefined,
        location: location !== undefined ? (location || null) : undefined,
        notes: notes !== undefined ? (notes || null) : undefined,
        isDone: isDone !== undefined ? !!isDone : undefined,
        reminderMinutes: reminderMinutes !== undefined ? (reminderMinutes ? parseInt(reminderMinutes) : null) : undefined,
        updatedById: req.user.id,
      },
      include: auditInclude,
    });
    res.json(updated);
  } catch (e) {
    res.status(500).json({ error: 'Eroare server' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const item = await prisma.householdEvent.findUnique({ where: { id: req.params.id } });
    if (!item) return res.status(404).json({ error: 'Inexistent' });
    const access = await getHouseholdAccess(req.user.id, item.householdId);
    if (!access.ok) return res.status(access.status).json({ error: access.error });
    if (access.role !== 'owner' && item.userId !== req.user.id) {
      return res.status(403).json({ error: 'Poți șterge doar evenimentele tale' });
    }
    await prisma.householdEvent.delete({ where: { id: req.params.id } });
    res.json({ message: 'Șters' });
  } catch (e) {
    res.status(500).json({ error: 'Eroare server' });
  }
});

module.exports = router;
