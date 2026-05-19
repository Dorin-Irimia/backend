const express = require('express');
const prisma = require('../prisma');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const { authMiddleware } = require('../middleware/auth');
const { audit } = require('../middleware/audit');
const { auditInclude } = require('../utils/audit');
const { getHouseholdAccess, accessibleHouseholdIds } = require('../utils/householdAccess');
const { notifyVehicleMembers } = require('../utils/notify'); // generic notify, vom face altul mai jos
const prismaClient = prisma;

const router = express.Router();

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, '../../uploads/household');
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) =>
    cb(null, `he-${Date.now()}-${Math.round(Math.random() * 1e9)}${path.extname(file.originalname) || ''}`),
});
const upload = multer({ storage, limits: { fileSize: 25 * 1024 * 1024, files: 20 } }).array('attachments', 20);

router.use(authMiddleware);

function kindFromMime(mime) {
  if (!mime) return 'other';
  if (mime.startsWith('image/')) return 'image';
  if (mime === 'application/pdf') return 'pdf';
  if (mime.includes('officedocument') || mime.includes('msword')) return 'doc';
  return 'other';
}
function parseJson(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch { return null; }
}
function cleanupUploadedFiles(files = []) {
  files.forEach(f => fs.unlink(f.path, () => {}));
}

async function notifyHouseholdMembers(householdId, excludeUserId, title, body) {
  try {
    const household = await prismaClient.household.findUnique({
      where: { id: householdId },
      include: { members: true },
    });
    if (!household) return;
    const userIds = new Set([household.userId, ...household.members.map(m => m.userId)]);
    if (excludeUserId) userIds.delete(excludeUserId);
    const recipients = [...userIds];
    if (recipients.length === 0) return;
    const users = await prismaClient.user.findMany({
      where: { id: { in: recipients } },
      select: { id: true, pushToken: true },
    });
    await prismaClient.notification.createMany({
      data: recipients.map(uid => ({
        userId: uid, title, body, type: 'info',
        relatedId: householdId, relatedType: 'Household',
      })),
    });
    const { sendPush } = require('../utils/push');
    const tokens = users.map(u => u.pushToken).filter(Boolean);
    if (tokens.length) sendPush(tokens, { title, body, data: { type: 'info', relatedType: 'Household', relatedId: householdId } }).catch(() => {});
  } catch (e) { console.error('notifyHouseholdMembers:', e.message); }
}

router.get('/', async (req, res) => {
  try {
    const { householdId, userId, from, to } = req.query;
    let allowedIds;
    if (householdId) {
      const access = await getHouseholdAccess(req.user.id, householdId);
      if (!access.ok) return res.status(access.status).json({ error: access.error });
      allowedIds = [householdId];
    } else {
      allowedIds = await accessibleHouseholdIds(req.user.id);
    }
    const where = { householdId: { in: allowedIds } };
    if (userId) where.userId = userId;
    if (from || to) {
      where.date = {};
      if (from) where.date.gte = from;
      if (to) where.date.lte = to;
    }
    const items = await prisma.householdExpense.findMany({
      where,
      orderBy: { date: 'desc' },
      include: { ...auditInclude, attachments: { orderBy: { createdAt: 'asc' } } },
    });
    res.json(items);
  } catch (e) {
    res.status(500).json({ error: 'Eroare server' });
  }
});

router.get('/stats/by-user', async (req, res) => {
  try {
    const { householdId, month } = req.query;
    if (!householdId) return res.status(400).json({ error: 'householdId obligatoriu' });
    const access = await getHouseholdAccess(req.user.id, householdId);
    if (!access.ok) return res.status(access.status).json({ error: access.error });

    const targetMonth = month && /^\d{4}-\d{2}$/.test(month) ? month : new Date().toISOString().slice(0, 7);
    const monthStart = `${targetMonth}-01`;
    const [y, m] = targetMonth.split('-').map(Number);
    const nextMonth = new Date(Date.UTC(y, m, 1));
    const monthEnd = nextMonth.toISOString().slice(0, 10);

    const expenses = await prisma.householdExpense.findMany({
      where: { householdId, date: { gte: monthStart, lt: monthEnd } },
      include: { user: { select: { id: true, name: true, email: true, avatar: true } } },
    });

    const byUser = {};
    let totalSpent = 0;
    expenses.forEach(e => {
      const uid = e.userId;
      if (!byUser[uid]) byUser[uid] = { user: e.user, total: 0, count: 0, byCategory: {} };
      byUser[uid].total += Number(e.amount || 0);
      byUser[uid].count += 1;
      const c = e.category || 'altele';
      byUser[uid].byCategory[c] = (byUser[uid].byCategory[c] || 0) + Number(e.amount || 0);
      totalSpent += Number(e.amount || 0);
    });
    const breakdown = Object.values(byUser)
      .map(u => ({ ...u, share: totalSpent > 0 ? (u.total / totalSpent) * 100 : 0 }))
      .sort((a, b) => b.total - a.total);
    res.json({ month: targetMonth, totalSpent, users: breakdown });
  } catch (e) {
    console.error('expenses by-user:', e);
    res.status(500).json({ error: 'Eroare server' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const item = await prisma.householdExpense.findUnique({
      where: { id: req.params.id },
      include: { ...auditInclude, attachments: { orderBy: { createdAt: 'asc' } } },
    });
    if (!item) return res.status(404).json({ error: 'Inexistent' });
    const access = await getHouseholdAccess(req.user.id, item.householdId);
    if (!access.ok) return res.status(access.status).json({ error: access.error });
    res.json(item);
  } catch (e) {
    res.status(500).json({ error: 'Eroare server' });
  }
});

router.post('/', upload, async (req, res) => {
  try {
    const {
      clientId, householdId, title, amount, currency, category, date, time,
      merchant, location, notes, customFields, splitMode, splitShares,
      source, sourceId,
    } = req.body;
    if (!householdId || !title || !amount || !date) {
      cleanupUploadedFiles(req.files);
      return res.status(400).json({ error: 'Câmpuri obligatorii: locuință, titlu, sumă, dată' });
    }
    const normalizedClientId = clientId ? String(clientId) : null;
    if (normalizedClientId) {
      const existing = await prisma.householdExpense.findUnique({
        where: { userId_clientId: { userId: req.user.id, clientId: normalizedClientId } },
        include: { ...auditInclude, attachments: { orderBy: { createdAt: 'asc' } } },
      });
      if (existing) {
        cleanupUploadedFiles(req.files);
        return res.json(existing);
      }
    }
    const access = await getHouseholdAccess(req.user.id, householdId);
    if (!access.ok) return res.status(access.status).json({ error: access.error });

    const exp = await prisma.householdExpense.create({
      data: {
        clientId: normalizedClientId,
        userId: req.user.id,
        householdId,
        title,
        amount: parseFloat(amount),
        currency: currency || 'RON',
        category: category || 'altele',
        date, time: time || null,
        merchant: merchant || null,
        location: location || null,
        notes: notes || null,
        customFields: parseJson(customFields),
        splitMode: splitMode || 'single',
        splitShares: parseJson(splitShares),
        source: source || null,
        sourceId: sourceId || null,
      },
    });

    for (const file of req.files || []) {
      await prisma.attachment.create({
        data: {
          userId: req.user.id,
          householdExpenseId: exp.id,
          fileName: file.originalname,
          fileUrl: `/uploads/household/${file.filename}`,
          mimeType: file.mimetype,
          fileSize: file.size,
          kind: kindFromMime(file.mimetype),
        },
      });
    }

    await audit(req.user.id, 'CREATE', 'HouseholdExpense', exp.id, title, req.ip);

    if (access.role === 'member') {
      const household = await prisma.household.findUnique({ where: { id: householdId } });
      notifyHouseholdMembers(
        householdId,
        req.user.id,
        '🏠 Cheltuială nouă',
        `${req.user.name} a adăugat "${title}" (${parseFloat(amount).toFixed(2)} ${currency || 'RON'}) la ${household?.name}.`,
      );
    }

    const fresh = await prisma.householdExpense.findUnique({
      where: { id: exp.id },
      include: { ...auditInclude, attachments: { orderBy: { createdAt: 'asc' } } },
    });
    res.status(201).json(fresh);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Eroare server' });
  }
});

router.put('/:id', upload, async (req, res) => {
  try {
    const item = await prisma.householdExpense.findUnique({ where: { id: req.params.id } });
    if (!item) return res.status(404).json({ error: 'Inexistent' });
    const access = await getHouseholdAccess(req.user.id, item.householdId);
    if (!access.ok) return res.status(access.status).json({ error: access.error });
    if (access.role !== 'owner' && item.userId !== req.user.id) {
      return res.status(403).json({ error: 'Poți edita doar cheltuielile adăugate de tine' });
    }

    const {
      title, amount, currency, category, date, time,
      merchant, location, notes, customFields, splitMode, splitShares,
    } = req.body;

    const updated = await prisma.householdExpense.update({
      where: { id: req.params.id },
      data: {
        title: title || undefined,
        amount: amount !== undefined ? parseFloat(amount) : undefined,
        currency: currency || undefined,
        category: category || undefined,
        date: date || undefined,
        time: time !== undefined ? (time || null) : undefined,
        merchant: merchant !== undefined ? (merchant || null) : undefined,
        location: location !== undefined ? (location || null) : undefined,
        notes: notes !== undefined ? (notes || null) : undefined,
        customFields: customFields !== undefined ? parseJson(customFields) : undefined,
        splitMode: splitMode !== undefined ? (splitMode || 'single') : undefined,
        splitShares: splitShares !== undefined ? parseJson(splitShares) : undefined,
        updatedById: req.user.id,
      },
    });
    for (const file of req.files || []) {
      await prisma.attachment.create({
        data: {
          userId: req.user.id,
          householdExpenseId: updated.id,
          fileName: file.originalname,
          fileUrl: `/uploads/household/${file.filename}`,
          mimeType: file.mimetype,
          fileSize: file.size,
          kind: kindFromMime(file.mimetype),
        },
      });
    }
    const fresh = await prisma.householdExpense.findUnique({
      where: { id: updated.id },
      include: { ...auditInclude, attachments: { orderBy: { createdAt: 'asc' } } },
    });
    res.json(fresh);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Eroare server' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const item = await prisma.householdExpense.findUnique({
      where: { id: req.params.id },
      include: { attachments: true },
    });
    if (!item) return res.status(404).json({ error: 'Inexistent' });
    const access = await getHouseholdAccess(req.user.id, item.householdId);
    if (!access.ok) return res.status(access.status).json({ error: access.error });
    if (access.role !== 'owner' && item.userId !== req.user.id) {
      return res.status(403).json({ error: 'Poți șterge doar cheltuielile adăugate de tine' });
    }
    item.attachments.forEach(a => {
      const p = path.join(__dirname, '../..', a.fileUrl.replace(/^\//, ''));
      fs.unlink(p, () => {});
    });
    await prisma.householdExpense.delete({ where: { id: req.params.id } });
    res.json({ message: 'Șters' });
  } catch (e) {
    res.status(500).json({ error: 'Eroare server' });
  }
});

module.exports = router;
