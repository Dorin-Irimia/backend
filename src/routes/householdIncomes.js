const express = require('express');
const prisma = require('../prisma');
const { authMiddleware } = require('../middleware/auth');
const { audit } = require('../middleware/audit');
const { auditInclude } = require('../utils/audit');
const { getHouseholdAccess, accessibleHouseholdIds } = require('../utils/householdAccess');

const router = express.Router();
router.use(authMiddleware);

function parseJson(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch { return null; }
}

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
    const items = await prisma.householdIncome.findMany({
      where: { householdId: { in: allowedIds } },
      orderBy: { date: 'desc' },
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
      clientId, householdId, title, amount, currency, category, date,
      source, recurring, notes, customFields,
    } = req.body;
    if (!householdId || !title || !amount || !date) {
      return res.status(400).json({ error: 'Câmpuri obligatorii: locuință, titlu, sumă, dată' });
    }
    const normalizedClientId = clientId ? String(clientId) : null;
    if (normalizedClientId) {
      const existing = await prisma.householdIncome.findUnique({
        where: { userId_clientId: { userId: req.user.id, clientId: normalizedClientId } },
      });
      if (existing) return res.json(existing);
    }
    const access = await getHouseholdAccess(req.user.id, householdId);
    if (!access.ok) return res.status(access.status).json({ error: access.error });

    const inc = await prisma.householdIncome.create({
      data: {
        clientId: normalizedClientId,
        userId: req.user.id,
        householdId,
        title,
        amount: parseFloat(amount),
        currency: currency || 'RON',
        category: category || 'altele',
        date,
        source: source || null,
        recurring: recurring || 'none',
        notes: notes || null,
        customFields: parseJson(customFields),
      },
    });
    await audit(req.user.id, 'CREATE', 'HouseholdIncome', inc.id, title, req.ip);
    res.status(201).json(inc);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Eroare server' });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const item = await prisma.householdIncome.findUnique({ where: { id: req.params.id } });
    if (!item) return res.status(404).json({ error: 'Inexistent' });
    const access = await getHouseholdAccess(req.user.id, item.householdId);
    if (!access.ok) return res.status(access.status).json({ error: access.error });
    if (access.role !== 'owner' && item.userId !== req.user.id) {
      return res.status(403).json({ error: 'Poți edita doar veniturile tale' });
    }
    const {
      title, amount, currency, category, date, source, recurring, notes, customFields,
    } = req.body;
    const updated = await prisma.householdIncome.update({
      where: { id: req.params.id },
      data: {
        title: title || undefined,
        amount: amount !== undefined ? parseFloat(amount) : undefined,
        currency: currency || undefined,
        category: category || undefined,
        date: date || undefined,
        source: source !== undefined ? (source || null) : undefined,
        recurring: recurring || undefined,
        notes: notes !== undefined ? (notes || null) : undefined,
        customFields: customFields !== undefined ? parseJson(customFields) : undefined,
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
    const item = await prisma.householdIncome.findUnique({ where: { id: req.params.id } });
    if (!item) return res.status(404).json({ error: 'Inexistent' });
    const access = await getHouseholdAccess(req.user.id, item.householdId);
    if (!access.ok) return res.status(access.status).json({ error: access.error });
    if (access.role !== 'owner' && item.userId !== req.user.id) {
      return res.status(403).json({ error: 'Poți șterge doar veniturile tale' });
    }
    await prisma.householdIncome.delete({ where: { id: req.params.id } });
    res.json({ message: 'Șters' });
  } catch (e) {
    res.status(500).json({ error: 'Eroare server' });
  }
});

module.exports = router;
