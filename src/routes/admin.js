const prisma = require('../prisma');
const express = require('express');

const { authMiddleware, adminOnly } = require('../middleware/auth');

const router = express.Router();


router.use(authMiddleware, adminOnly);

router.get('/users', async (req, res) => {
  const users = await prisma.user.findMany({
    select: { id: true, email: true, name: true, phone: true, role: true, createdAt: true, _count: { select: { vehicles: true, documents: true, invoices: true } } },
    orderBy: { createdAt: 'desc' },
  });
  res.json(users);
});

router.get('/audit-logs', async (req, res) => {
  const { userId, limit = 100 } = req.query;
  const logs = await prisma.auditLog.findMany({
    where: userId ? { userId } : {},
    include: { user: { select: { name: true, email: true } } },
    orderBy: { createdAt: 'desc' },
    take: parseInt(limit),
  });
  res.json(logs);
});

router.put('/users/:id/role', async (req, res) => {
  const { role } = req.body;
  if (!['user', 'admin'].includes(role)) return res.status(400).json({ error: 'Rol invalid' });
  const updated = await prisma.user.update({ where: { id: req.params.id }, data: { role } });
  res.json({ id: updated.id, role: updated.role });
});

router.delete('/users/:id', async (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error: 'Nu îți poți șterge propriul cont' });
  await prisma.user.delete({ where: { id: req.params.id } });
  res.json({ message: 'Utilizator șters' });
});

module.exports = router;
