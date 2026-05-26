// Layouts pentru dashboard-ul web. Endpoint-uri simple CRUD legate de user.
const express = require('express');
const prisma = require('../prisma');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();
router.use(authMiddleware);

router.get('/', async (req, res) => {
  try {
    const items = await prisma.dashboardLayout.findMany({
      where: { userId: req.user.id },
      orderBy: [{ isDefault: 'desc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
    res.json(items);
  } catch (e) {
    console.error('dashboard list:', e);
    res.status(500).json({ error: 'Eroare server' });
  }
});

router.post('/', async (req, res) => {
  try {
    const { name, layout, isDefault, sortOrder } = req.body;
    // Un singur default — dacă cere isDefault, dezactivăm celelalte.
    if (isDefault) {
      await prisma.dashboardLayout.updateMany({
        where: { userId: req.user.id, isDefault: true },
        data: { isDefault: false },
      });
    }
    const created = await prisma.dashboardLayout.create({
      data: {
        userId: req.user.id,
        name: name || 'Implicit',
        layout: layout || [],
        isDefault: !!isDefault,
        sortOrder: sortOrder ?? 0,
      },
    });
    res.status(201).json(created);
  } catch (e) {
    console.error('dashboard create:', e);
    res.status(500).json({ error: 'Eroare server' });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const item = await prisma.dashboardLayout.findUnique({ where: { id: req.params.id } });
    if (!item || item.userId !== req.user.id) return res.status(404).json({ error: 'Inexistent' });

    const { name, layout, isDefault, sortOrder } = req.body;
    if (isDefault) {
      await prisma.dashboardLayout.updateMany({
        where: { userId: req.user.id, isDefault: true, id: { not: item.id } },
        data: { isDefault: false },
      });
    }
    const updated = await prisma.dashboardLayout.update({
      where: { id: item.id },
      data: {
        name: name ?? undefined,
        layout: layout ?? undefined,
        isDefault: isDefault ?? undefined,
        sortOrder: sortOrder ?? undefined,
      },
    });
    res.json(updated);
  } catch (e) {
    console.error('dashboard update:', e);
    res.status(500).json({ error: 'Eroare server' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const item = await prisma.dashboardLayout.findUnique({ where: { id: req.params.id } });
    if (!item || item.userId !== req.user.id) return res.status(404).json({ error: 'Inexistent' });
    await prisma.dashboardLayout.delete({ where: { id: item.id } });
    res.json({ ok: true });
  } catch (e) {
    console.error('dashboard delete:', e);
    res.status(500).json({ error: 'Eroare server' });
  }
});

module.exports = router;
