const express = require('express');
const prisma = require('../prisma');
const { authMiddleware } = require('../middleware/auth');
const { audit } = require('../middleware/audit');
const { auditInclude } = require('../utils/audit');
const { getHouseholdAccess, accessibleHouseholdIds } = require('../utils/householdAccess');

const router = express.Router();
router.use(authMiddleware);

// ─── Categories ────────────────────────────────────────────────────────────
router.get('/categories', async (req, res) => {
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
    const items = await prisma.budgetCategory.findMany({
      where: { householdId: { in: allowedIds } },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      include: auditInclude,
    });
    res.json(items);
  } catch (e) {
    console.error('budget categories list:', e);
    res.status(500).json({ error: 'Eroare server' });
  }
});

router.post('/categories', async (req, res) => {
  try {
    const { clientId, householdId, key, label, icon, color, monthlyLimit, sortOrder } = req.body;
    if (!householdId || !key || !label) {
      return res.status(400).json({ error: 'Câmpuri obligatorii: locuință, cheie, etichetă' });
    }

    const access = await getHouseholdAccess(req.user.id, householdId);
    if (!access.ok) return res.status(access.status).json({ error: access.error });

    // Upsert by householdId+key — adding the same key twice updates the existing row.
    const cat = await prisma.budgetCategory.upsert({
      where: { householdId_key: { householdId, key } },
      update: {
        label,
        icon: icon || '📦',
        color: color || '#6B7280',
        monthlyLimit: monthlyLimit != null ? parseFloat(monthlyLimit) : 0,
        sortOrder: sortOrder != null ? parseInt(sortOrder, 10) : 0,
      },
      create: {
        clientId: clientId ? String(clientId) : null,
        userId: req.user.id,
        householdId,
        key, label,
        icon: icon || '📦',
        color: color || '#6B7280',
        monthlyLimit: monthlyLimit != null ? parseFloat(monthlyLimit) : 0,
        sortOrder: sortOrder != null ? parseInt(sortOrder, 10) : 0,
      },
    });
    await audit(req.user.id, 'UPSERT', 'BudgetCategory', cat.id, label, req.ip);
    res.status(201).json(cat);
  } catch (e) {
    console.error('budget categories create:', e);
    res.status(500).json({ error: 'Eroare server' });
  }
});

router.put('/categories/:id', async (req, res) => {
  try {
    const cat = await prisma.budgetCategory.findUnique({ where: { id: req.params.id } });
    if (!cat) return res.status(404).json({ error: 'Inexistent' });
    const access = await getHouseholdAccess(req.user.id, cat.householdId);
    if (!access.ok) return res.status(access.status).json({ error: access.error });

    const { label, icon, color, monthlyLimit, sortOrder } = req.body;
    const updated = await prisma.budgetCategory.update({
      where: { id: req.params.id },
      data: {
        label: label !== undefined ? label : undefined,
        icon: icon !== undefined ? icon : undefined,
        color: color !== undefined ? color : undefined,
        monthlyLimit: monthlyLimit !== undefined ? parseFloat(monthlyLimit) : undefined,
        sortOrder: sortOrder !== undefined ? parseInt(sortOrder, 10) : undefined,
        updatedById: req.user.id,
      },
      include: auditInclude,
    });
    res.json(updated);
  } catch (e) {
    console.error('budget categories update:', e);
    res.status(500).json({ error: 'Eroare server' });
  }
});

router.delete('/categories/:id', async (req, res) => {
  try {
    const cat = await prisma.budgetCategory.findUnique({ where: { id: req.params.id } });
    if (!cat) return res.status(404).json({ error: 'Inexistent' });
    const access = await getHouseholdAccess(req.user.id, cat.householdId);
    if (!access.ok) return res.status(access.status).json({ error: access.error });
    await prisma.budgetCategory.delete({ where: { id: req.params.id } });
    res.json({ message: 'Șters' });
  } catch (e) {
    console.error('budget categories delete:', e);
    res.status(500).json({ error: 'Eroare server' });
  }
});

// ─── Summary: categories + spent (current month) ───────────────────────────
router.get('/summary', async (req, res) => {
  try {
    const { householdId, month } = req.query;
    if (!householdId) return res.status(400).json({ error: 'householdId obligatoriu' });

    const access = await getHouseholdAccess(req.user.id, householdId);
    if (!access.ok) return res.status(access.status).json({ error: access.error });

    // Default to current month (YYYY-MM)
    const targetMonth = month && /^\d{4}-\d{2}$/.test(month) ? month : new Date().toISOString().slice(0, 7);

    const categories = await prisma.budgetCategory.findMany({
      where: { householdId },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });

    // Pull all expenses in the target month
    const monthStart = `${targetMonth}-01`;
    const [y, m] = targetMonth.split('-').map(Number);
    const nextMonth = new Date(Date.UTC(y, m, 1));
    const monthEnd = nextMonth.toISOString().slice(0, 10);

    const expenses = await prisma.householdExpense.findMany({
      where: {
        householdId,
        date: { gte: monthStart, lt: monthEnd },
      },
      select: { category: true, amount: true },
    });

    const spentByCategory = {};
    let totalSpent = 0;
    for (const ex of expenses) {
      const key = ex.category || 'altele';
      spentByCategory[key] = (spentByCategory[key] || 0) + (ex.amount || 0);
      totalSpent += ex.amount || 0;
    }

    const breakdown = categories.map(c => ({
      ...c,
      spent: Math.round((spentByCategory[c.key] || 0) * 100) / 100,
    }));
    const tracked = new Set(categories.map(c => c.key));
    const otherSpent = Object.entries(spentByCategory)
      .filter(([k]) => !tracked.has(k))
      .reduce((s, [, v]) => s + v, 0);

    res.json({
      month: targetMonth,
      categories: breakdown,
      totalSpent: Math.round(totalSpent * 100) / 100,
      otherSpent: Math.round(otherSpent * 100) / 100,
    });
  } catch (e) {
    console.error('budget summary:', e);
    res.status(500).json({ error: 'Eroare server' });
  }
});

module.exports = router;
