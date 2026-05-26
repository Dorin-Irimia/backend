// Filter presets — rapoarte salvate per entitate (expenses, incomes, vehicles).
const express = require('express');
const prisma = require('../prisma');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();
router.use(authMiddleware);

router.get('/', async (req, res) => {
  try {
    const { entity } = req.query;
    const where = { userId: req.user.id };
    if (entity) where.entity = entity;
    const items = await prisma.filterPreset.findMany({
      where,
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
    res.json(items);
  } catch (e) {
    console.error('filterPresets list:', e);
    res.status(500).json({ error: 'Eroare server' });
  }
});

router.post('/', async (req, res) => {
  try {
    const { name, entity, config, sortOrder } = req.body;
    if (!name || !entity || !config) {
      return res.status(400).json({ error: 'Nume, entitate și config obligatorii' });
    }
    const created = await prisma.filterPreset.create({
      data: {
        userId: req.user.id,
        name, entity, config, sortOrder: sortOrder ?? 0,
      },
    });
    res.status(201).json(created);
  } catch (e) {
    console.error('filterPresets create:', e);
    res.status(500).json({ error: 'Eroare server' });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const item = await prisma.filterPreset.findUnique({ where: { id: req.params.id } });
    if (!item || item.userId !== req.user.id) return res.status(404).json({ error: 'Inexistent' });
    const { name, config, sortOrder } = req.body;
    const updated = await prisma.filterPreset.update({
      where: { id: item.id },
      data: {
        name: name ?? undefined,
        config: config ?? undefined,
        sortOrder: sortOrder ?? undefined,
      },
    });
    res.json(updated);
  } catch (e) {
    res.status(500).json({ error: 'Eroare server' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const item = await prisma.filterPreset.findUnique({ where: { id: req.params.id } });
    if (!item || item.userId !== req.user.id) return res.status(404).json({ error: 'Inexistent' });
    await prisma.filterPreset.delete({ where: { id: item.id } });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Eroare server' });
  }
});

module.exports = router;
