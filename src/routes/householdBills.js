const express = require('express');
const prisma = require('../prisma');
const { authMiddleware } = require('../middleware/auth');
const { audit } = require('../middleware/audit');
const { auditInclude } = require('../utils/audit');
const { getHouseholdAccess, accessibleHouseholdIds } = require('../utils/householdAccess');

const router = express.Router();
router.use(authMiddleware);

// Automatically promote bills that are past their due date and still unpaid to 'overdue'.
function autoStatus(b) {
  if (b.status === 'paid' || b.status === 'overdue' || b.status === 'scheduled') return b.status;
  if (!b.dueDate) return 'due';
  const today = new Date().toISOString().slice(0, 10);
  return b.dueDate < today ? 'overdue' : 'due';
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
    const items = await prisma.householdBill.findMany({
      where: { householdId: { in: allowedIds } },
      orderBy: { dueDate: 'asc' },
      include: auditInclude,
    });
    res.json(items.map(b => ({ ...b, status: autoStatus(b) })));
  } catch (e) {
    console.error('bills list:', e);
    res.status(500).json({ error: 'Eroare server' });
  }
});

router.post('/', async (req, res) => {
  try {
    const {
      clientId, householdId, provider, name, icon, color, amount, currency, dueDate, status, recurring, notes,
    } = req.body;

    if (!householdId || !name || !provider || amount == null || !dueDate) {
      return res.status(400).json({ error: 'Câmpuri obligatorii: locuință, nume, furnizor, sumă, scadență' });
    }

    const normalizedClientId = clientId ? String(clientId) : null;
    if (normalizedClientId) {
      const existing = await prisma.householdBill.findUnique({
        where: { userId_clientId: { userId: req.user.id, clientId: normalizedClientId } },
      });
      if (existing) return res.json(existing);
    }

    const access = await getHouseholdAccess(req.user.id, householdId);
    if (!access.ok) return res.status(access.status).json({ error: access.error });

    const bill = await prisma.householdBill.create({
      data: {
        clientId: normalizedClientId,
        userId: req.user.id,
        householdId,
        provider,
        name,
        icon: icon || '📄',
        color: color || '#6B7280',
        amount: parseFloat(amount),
        currency: currency || 'RON',
        dueDate,
        status: status || 'due',
        recurring: recurring || 'lunar',
        notes: notes || null,
      },
    });
    await audit(req.user.id, 'CREATE', 'HouseholdBill', bill.id, name, req.ip);
    res.status(201).json(bill);
  } catch (e) {
    console.error('bills create:', e);
    res.status(500).json({ error: 'Eroare server' });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const item = await prisma.householdBill.findUnique({ where: { id: req.params.id } });
    if (!item) return res.status(404).json({ error: 'Inexistent' });

    const access = await getHouseholdAccess(req.user.id, item.householdId);
    if (!access.ok) return res.status(access.status).json({ error: access.error });
    if (access.role !== 'owner' && item.userId !== req.user.id) {
      return res.status(403).json({ error: 'Doar autorul poate edita' });
    }

    const {
      provider, name, icon, color, amount, currency, dueDate, status, paidDate, recurring, notes,
    } = req.body;

    const updated = await prisma.householdBill.update({
      where: { id: req.params.id },
      data: {
        provider:  provider !== undefined ? provider : undefined,
        name:      name !== undefined ? name : undefined,
        icon:      icon !== undefined ? icon : undefined,
        color:     color !== undefined ? color : undefined,
        amount:    amount !== undefined ? parseFloat(amount) : undefined,
        currency:  currency !== undefined ? currency : undefined,
        dueDate:   dueDate !== undefined ? dueDate : undefined,
        status:    status !== undefined ? status : undefined,
        paidDate:  paidDate !== undefined ? (paidDate || null) : undefined,
        recurring: recurring !== undefined ? recurring : undefined,
        notes:     notes !== undefined ? (notes || null) : undefined,
        updatedById: req.user.id,
      },
      include: auditInclude,
    });
    res.json(updated);
  } catch (e) {
    console.error('bills update:', e);
    res.status(500).json({ error: 'Eroare server' });
  }
});

router.post('/:id/pay', async (req, res) => {
  try {
    const item = await prisma.householdBill.findUnique({ where: { id: req.params.id } });
    if (!item) return res.status(404).json({ error: 'Inexistent' });
    const access = await getHouseholdAccess(req.user.id, item.householdId);
    if (!access.ok) return res.status(access.status).json({ error: access.error });

    const today = new Date().toISOString().slice(0, 10);
    const updated = await prisma.householdBill.update({
      where: { id: req.params.id },
      data: { status: 'paid', paidDate: today },
    });
    res.json(updated);
  } catch (e) {
    console.error('bills pay:', e);
    res.status(500).json({ error: 'Eroare server' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const item = await prisma.householdBill.findUnique({ where: { id: req.params.id } });
    if (!item) return res.status(404).json({ error: 'Inexistent' });

    const access = await getHouseholdAccess(req.user.id, item.householdId);
    if (!access.ok) return res.status(access.status).json({ error: access.error });
    if (access.role !== 'owner' && item.userId !== req.user.id) {
      return res.status(403).json({ error: 'Doar autorul poate șterge' });
    }

    await prisma.householdBill.delete({ where: { id: req.params.id } });
    res.json({ message: 'Șters' });
  } catch (e) {
    console.error('bills delete:', e);
    res.status(500).json({ error: 'Eroare server' });
  }
});

module.exports = router;
