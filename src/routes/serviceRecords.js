const express = require('express');
const prisma = require('../prisma');
const { authMiddleware } = require('../middleware/auth');
const { audit } = require('../middleware/audit');
const { auditInclude } = require('../utils/audit');
const { getVehicleAccess, accessibleVehicleIds } = require('../utils/vehicleAccess');

const router = express.Router();
router.use(authMiddleware);

router.get('/', async (req, res) => {
  try {
    const { vehicleId } = req.query;
    let allowedIds;
    if (vehicleId) {
      const access = await getVehicleAccess(req.user.id, vehicleId);
      if (!access.ok) return res.status(access.status).json({ error: access.error });
      allowedIds = [vehicleId];
    } else {
      allowedIds = await accessibleVehicleIds(req.user.id);
    }
    const items = await prisma.serviceRecord.findMany({
      where: { vehicleId: { in: allowedIds } },
      orderBy: { date: 'desc' },
      include: auditInclude,
    });
    res.json(items);
  } catch (e) {
    console.error('serviceRecords list:', e);
    res.status(500).json({ error: 'Eroare server' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const item = await prisma.serviceRecord.findUnique({ where: { id: req.params.id } });
    if (!item) return res.status(404).json({ error: 'Inexistent' });
    const access = await getVehicleAccess(req.user.id, item.vehicleId);
    if (!access.ok) return res.status(access.status).json({ error: access.error });
    res.json(item);
  } catch (e) {
    res.status(500).json({ error: 'Eroare server' });
  }
});

router.post('/', async (req, res) => {
  try {
    const {
      clientId, vehicleId, date, km, type, title, provider, cost, upcoming, notes,
    } = req.body;

    if (!vehicleId || !date || !title || !type) {
      return res.status(400).json({ error: 'Câmpuri obligatorii: vehicul, dată, titlu, tip' });
    }

    const normalizedClientId = clientId ? String(clientId) : null;
    if (normalizedClientId) {
      const existing = await prisma.serviceRecord.findUnique({
        where: { userId_clientId: { userId: req.user.id, clientId: normalizedClientId } },
      });
      if (existing) return res.json(existing);
    }

    const access = await getVehicleAccess(req.user.id, vehicleId);
    if (!access.ok) return res.status(access.status).json({ error: access.error });

    const rec = await prisma.serviceRecord.create({
      data: {
        clientId: normalizedClientId,
        userId: req.user.id,
        vehicleId,
        date,
        km: km != null && km !== '' ? parseInt(km, 10) : null,
        type,
        title,
        provider: provider || null,
        cost: cost != null && cost !== '' ? parseFloat(cost) : 0,
        upcoming: !!upcoming,
        notes: notes || null,
      },
    });

    await audit(req.user.id, 'CREATE', 'ServiceRecord', rec.id, title, req.ip);
    res.status(201).json(rec);
  } catch (e) {
    console.error('serviceRecords create:', e);
    res.status(500).json({ error: 'Eroare server' });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const item = await prisma.serviceRecord.findUnique({ where: { id: req.params.id } });
    if (!item) return res.status(404).json({ error: 'Inexistent' });

    const access = await getVehicleAccess(req.user.id, item.vehicleId);
    if (!access.ok) return res.status(access.status).json({ error: access.error });
    if (access.role !== 'owner' && item.userId !== req.user.id) {
      return res.status(403).json({ error: 'Poți edita doar înregistrările tale' });
    }

    const { date, km, type, title, provider, cost, upcoming, notes } = req.body;
    const updated = await prisma.serviceRecord.update({
      where: { id: req.params.id },
      data: {
        date: date || undefined,
        km: km !== undefined ? (km === '' || km === null ? null : parseInt(km, 10)) : undefined,
        type: type || undefined,
        title: title || undefined,
        provider: provider !== undefined ? (provider || null) : undefined,
        cost: cost !== undefined ? (cost === '' || cost === null ? 0 : parseFloat(cost)) : undefined,
        upcoming: upcoming !== undefined ? !!upcoming : undefined,
        notes: notes !== undefined ? (notes || null) : undefined,
        updatedById: req.user.id,
      },
      include: auditInclude,
    });
    res.json(updated);
  } catch (e) {
    console.error('serviceRecords update:', e);
    res.status(500).json({ error: 'Eroare server' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const item = await prisma.serviceRecord.findUnique({ where: { id: req.params.id } });
    if (!item) return res.status(404).json({ error: 'Inexistent' });

    const access = await getVehicleAccess(req.user.id, item.vehicleId);
    if (!access.ok) return res.status(access.status).json({ error: access.error });
    if (access.role !== 'owner' && item.userId !== req.user.id) {
      return res.status(403).json({ error: 'Poți șterge doar înregistrările tale' });
    }

    await prisma.serviceRecord.delete({ where: { id: req.params.id } });
    res.json({ message: 'Șters' });
  } catch (e) {
    console.error('serviceRecords delete:', e);
    res.status(500).json({ error: 'Eroare server' });
  }
});

module.exports = router;
