// Categorii personalizate per utilizator. Spre deosebire de BudgetCategory
// (partajat per locuință), aceste categorii sunt private și acoperă atât
// cheltuielile cât și veniturile. Au cheie stabilă pe device (clientId)
// pentru sincronizare idempotentă cu mobile-ul.

const express = require('express');
const prisma = require('../prisma');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();
router.use(authMiddleware);

// GET / — toate categoriile user-ului. Opțional ?type=expense|income.
router.get('/', async (req, res) => {
  try {
    const { type } = req.query;
    const where = { userId: req.user.id };
    if (type === 'expense' || type === 'income') where.type = type;
    const items = await prisma.customCategory.findMany({
      where,
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
    res.json(items);
  } catch (e) {
    console.error('customCategories list:', e);
    res.status(500).json({ error: 'Eroare server' });
  }
});

// POST / — creează sau, dacă clientId este reutilizat, returnează existentul
// (idempotent, util pentru retry-ul cozii offline din mobile).
router.post('/', async (req, res) => {
  try {
    const { clientId, key, label, icon, color, type, sortOrder } = req.body;
    if (!key || !label) return res.status(400).json({ error: 'Cheie și etichetă obligatorii' });

    const normalizedClientId = clientId ? String(clientId) : null;
    if (normalizedClientId) {
      const existing = await prisma.customCategory.findUnique({
        where: { userId_clientId: { userId: req.user.id, clientId: normalizedClientId } },
      });
      if (existing) return res.json(existing);
    }

    // Dacă cheia există deja la acest user, facem update în loc de duplicate.
    const existingByKey = await prisma.customCategory.findUnique({
      where: { userId_key: { userId: req.user.id, key } },
    });
    if (existingByKey) {
      const updated = await prisma.customCategory.update({
        where: { id: existingByKey.id },
        data: {
          label, icon: icon || '📌', color: color || '#6B7280',
          type: type === 'income' ? 'income' : 'expense',
          sortOrder: sortOrder ?? existingByKey.sortOrder,
        },
      });
      return res.json(updated);
    }

    const created = await prisma.customCategory.create({
      data: {
        userId: req.user.id,
        clientId: normalizedClientId,
        key, label,
        icon: icon || '📌',
        color: color || '#6B7280',
        type: type === 'income' ? 'income' : 'expense',
        sortOrder: sortOrder ?? 0,
      },
    });
    res.status(201).json(created);
  } catch (e) {
    console.error('customCategories create:', e);
    res.status(500).json({ error: 'Eroare server' });
  }
});

// PUT /:key — update prin cheie (consistent cu modul în care mobile-ul
// adresează categoriile — nu generează un id separat în UI).
router.put('/:key', async (req, res) => {
  try {
    const { key } = req.params;
    const item = await prisma.customCategory.findUnique({
      where: { userId_key: { userId: req.user.id, key } },
    });
    if (!item) return res.status(404).json({ error: 'Categoria nu există' });

    const { label, icon, color, type, sortOrder } = req.body;
    const updated = await prisma.customCategory.update({
      where: { id: item.id },
      data: {
        label: label ?? undefined,
        icon: icon ?? undefined,
        color: color ?? undefined,
        type: type === 'income' || type === 'expense' ? type : undefined,
        sortOrder: sortOrder ?? undefined,
      },
    });
    res.json(updated);
  } catch (e) {
    console.error('customCategories update:', e);
    res.status(500).json({ error: 'Eroare server' });
  }
});

// DELETE /:key — șterge prin cheie.
router.delete('/:key', async (req, res) => {
  try {
    const { key } = req.params;
    const item = await prisma.customCategory.findUnique({
      where: { userId_key: { userId: req.user.id, key } },
    });
    if (!item) return res.status(404).json({ error: 'Categoria nu există' });
    await prisma.customCategory.delete({ where: { id: item.id } });
    res.json({ ok: true });
  } catch (e) {
    console.error('customCategories delete:', e);
    res.status(500).json({ error: 'Eroare server' });
  }
});

module.exports = router;
