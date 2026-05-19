const prisma = require('../prisma');
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const { authMiddleware } = require('../middleware/auth');
const { audit } = require('../middleware/audit');
const { auditInclude } = require('../utils/audit');
const { getVehicleAccess, accessibleVehicleIds } = require('../utils/vehicleAccess');
const { getHouseholdAccess } = require('../utils/householdAccess');
const { maybeUpdateVehicleKm } = require('../utils/availability');
const { notifyVehicleMembers } = require('../utils/notify');

const router = express.Router();

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, '../../uploads/invoices');
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) =>
    cb(null, `inv-${Date.now()}-${Math.round(Math.random() * 1e9)}${path.extname(file.originalname) || ''}`),
});
const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024, files: 20 },
}).array('attachments', 20);

router.use(authMiddleware);

function kindFromMime(mime) {
  if (!mime) return 'other';
  if (mime.startsWith('image/')) return 'image';
  if (mime === 'application/pdf') return 'pdf';
  if (mime.startsWith('application/msword') || mime.includes('officedocument') || mime.startsWith('text/')) return 'doc';
  return 'other';
}

function parseCustomFields(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function cleanupUploadedFiles(files = []) {
  files.forEach(file => fs.unlink(file.path, () => {}));
}

function notifyMembers(vehicleId, excludeUserId, title, body, type = 'info') {
  return notifyVehicleMembers(vehicleId, excludeUserId, { title, body, type });
}

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
    const invoices = await prisma.invoice.findMany({
      where: { vehicleId: { in: allowedIds } },
      orderBy: { date: 'desc' },
      include: {
        ...auditInclude,
        attachments: { orderBy: { createdAt: 'asc' } },
      },
    });
    res.json(invoices);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Eroare server' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const inv = await prisma.invoice.findUnique({
      where: { id: req.params.id },
      include: { attachments: { orderBy: { createdAt: 'asc' } } },
    });
    if (!inv) return res.status(404).json({ error: 'Inexistent' });
    const access = await getVehicleAccess(req.user.id, inv.vehicleId);
    if (!access.ok) return res.status(access.status).json({ error: access.error });
    res.json(inv);
  } catch (e) {
    res.status(500).json({ error: 'Eroare server' });
  }
});

router.post('/', upload, async (req, res) => {
  try {
    const {
      clientId, vehicleId, title, amount, currency, category, date, time, km,
      merchant, location, notes, customFields,
      // Optional sync flag: when set, after the invoice is created we also
      // create a linked HouseholdExpense in the user's household.
      syncToHouseholdId, syncCategory,
    } = req.body;
    if (!vehicleId || !title || !amount || !date) {
      return res.status(400).json({ error: 'Vehicul, titlu, sumă și dată sunt obligatorii' });
    }
    const normalizedClientId = clientId ? String(clientId) : null;
    if (normalizedClientId) {
      const existing = await prisma.invoice.findUnique({
        where: { userId_clientId: { userId: req.user.id, clientId: normalizedClientId } },
        include: { attachments: { orderBy: { createdAt: 'asc' } } },
      });
      if (existing) {
        cleanupUploadedFiles(req.files);
        return res.json(existing);
      }
    }
    const access = await getVehicleAccess(req.user.id, vehicleId);
    if (!access.ok) return res.status(access.status).json({ error: access.error });

    const invoice = await prisma.invoice.create({
      data: {
        clientId: normalizedClientId,
        userId: req.user.id,
        vehicleId,
        title,
        amount: parseFloat(amount),
        currency: currency || 'RON',
        category: category || 'altele',
        date,
        time: time || null,
        km: km ? parseInt(km) : null,
        merchant: merchant || null,
        location: location || null,
        notes: notes || null,
        customFields: parseCustomFields(customFields),
      },
    });

    const attachments = [];
    for (const file of req.files || []) {
      const att = await prisma.attachment.create({
        data: {
          userId: req.user.id,
          invoiceId: invoice.id,
          fileName: file.originalname,
          fileUrl: `/uploads/invoices/${file.filename}`,
          mimeType: file.mimetype,
          fileSize: file.size,
          kind: kindFromMime(file.mimetype),
        },
      });
      attachments.push(att);
    }

    if (km) {
      await maybeUpdateVehicleKm(vehicleId, km);
    }

    // Optional household sync — create a linked HouseholdExpense so the same
    // amount also shows up in the household budget/expenses without manual entry.
    let linkedHouseholdExpenseId = null;
    if (syncToHouseholdId) {
      try {
        const hhAccess = await getHouseholdAccess(req.user.id, syncToHouseholdId);
        if (hhAccess.ok) {
          const vehicle = await prisma.vehicle.findUnique({ where: { id: vehicleId } });
          const exp = await prisma.householdExpense.create({
            data: {
              userId: req.user.id,
              householdId: syncToHouseholdId,
              title: `${title} (${vehicle?.plate || 'mașină'})`,
              amount: parseFloat(amount),
              currency: currency || 'RON',
              category: syncCategory || 'transport',
              date,
              time: time || null,
              merchant: merchant || null,
              location: location || null,
              notes: notes || `Sincronizat din facturi auto · ${vehicle?.brand || ''} ${vehicle?.model || ''}`.trim(),
              source: 'invoice',
              sourceId: invoice.id,
            },
          });
          linkedHouseholdExpenseId = exp.id;
          await prisma.invoice.update({
            where: { id: invoice.id },
            data: { linkedHouseholdExpenseId: exp.id },
          });
        }
      } catch (syncErr) {
        console.error('invoice → household sync failed:', syncErr.message);
        // Non-fatal: the invoice is created, we just couldn't sync.
      }
    }

    await audit(req.user.id, 'CREATE', 'Invoice', invoice.id, title, req.ip);

    if (access.role === 'member') {
      const vehicle = await prisma.vehicle.findUnique({ where: { id: vehicleId } });
      await notifyMembers(
        vehicleId,
        req.user.id,
        'Cheltuială nouă',
        `${req.user.name} a adăugat "${title}" (${parseFloat(amount).toFixed(2)} ${currency || 'RON'}) pentru ${vehicle.plate}.`,
        'info',
      );
    }

    res.status(201).json({ ...invoice, attachments, linkedHouseholdExpenseId });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Eroare server' });
  }
});

router.put('/:id', upload, async (req, res) => {
  try {
    const inv = await prisma.invoice.findUnique({ where: { id: req.params.id } });
    if (!inv) return res.status(404).json({ error: 'Inexistent' });
    const access = await getVehicleAccess(req.user.id, inv.vehicleId);
    if (!access.ok) return res.status(access.status).json({ error: access.error });
    if (access.role !== 'owner' && inv.userId !== req.user.id) {
      return res.status(403).json({ error: 'Poți edita doar facturile adăugate de tine' });
    }

    const {
      title, amount, currency, category, date, time, km,
      merchant, location, notes, customFields,
    } = req.body;

    const updated = await prisma.invoice.update({
      where: { id: req.params.id },
      data: {
        title: title || undefined,
        amount: amount !== undefined ? parseFloat(amount) : undefined,
        currency: currency || undefined,
        category: category || undefined,
        date: date || undefined,
        time: time !== undefined ? (time || null) : undefined,
        km: km !== undefined ? (km ? parseInt(km) : null) : undefined,
        merchant: merchant !== undefined ? (merchant || null) : undefined,
        location: location !== undefined ? (location || null) : undefined,
        notes: notes !== undefined ? (notes || null) : undefined,
        customFields: customFields !== undefined ? parseCustomFields(customFields) : undefined,
        updatedById: req.user.id,
      },
      include: { ...auditInclude, attachments: { orderBy: { createdAt: 'asc' } } },
    });

    // Propagate amount/date to the linked household expense if one exists.
    if (inv.linkedHouseholdExpenseId) {
      try {
        await prisma.householdExpense.update({
          where: { id: inv.linkedHouseholdExpenseId },
          data: {
            amount: amount !== undefined ? parseFloat(amount) : undefined,
            date: date || undefined,
            updatedById: req.user.id,
          },
        });
      } catch {}
    }

    for (const file of req.files || []) {
      await prisma.attachment.create({
        data: {
          userId: req.user.id,
          invoiceId: updated.id,
          fileName: file.originalname,
          fileUrl: `/uploads/invoices/${file.filename}`,
          mimeType: file.mimetype,
          fileSize: file.size,
          kind: kindFromMime(file.mimetype),
        },
      });
    }

    const fresh = await prisma.invoice.findUnique({
      where: { id: updated.id },
      include: { ...auditInclude, attachments: { orderBy: { createdAt: 'asc' } } },
    });
    await audit(req.user.id, 'UPDATE', 'Invoice', updated.id, updated.title, req.ip);
    res.json(fresh);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Eroare server' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const inv = await prisma.invoice.findUnique({
      where: { id: req.params.id },
      include: { attachments: true },
    });
    if (!inv) return res.status(404).json({ error: 'Factură negăsită' });

    const access = await getVehicleAccess(req.user.id, inv.vehicleId);
    if (!access.ok) return res.status(access.status).json({ error: access.error });
    if (access.role !== 'owner' && inv.userId !== req.user.id) {
      return res.status(403).json({ error: 'Poți șterge doar facturile adăugate de tine' });
    }

    inv.attachments.forEach(a => {
      const p = path.join(__dirname, '../..', a.fileUrl.replace(/^\//, ''));
      fs.unlink(p, () => {});
    });

    if (inv.linkedHouseholdExpenseId) {
      try { await prisma.householdExpense.delete({ where: { id: inv.linkedHouseholdExpenseId } }); } catch {}
    }
    await prisma.invoice.delete({ where: { id: req.params.id } });
    await audit(req.user.id, 'DELETE', 'Invoice', req.params.id, inv.title, req.ip);
    res.json({ message: 'Factură ștearsă' });
  } catch (e) {
    res.status(500).json({ error: 'Eroare server' });
  }
});

// Attachment endpoints
router.post('/:id/attachments', upload, async (req, res) => {
  try {
    const inv = await prisma.invoice.findUnique({ where: { id: req.params.id } });
    if (!inv) return res.status(404).json({ error: 'Inexistent' });
    const access = await getVehicleAccess(req.user.id, inv.vehicleId);
    if (!access.ok) return res.status(access.status).json({ error: access.error });

    const created = [];
    for (const file of req.files || []) {
      const att = await prisma.attachment.create({
        data: {
          userId: req.user.id,
          invoiceId: inv.id,
          fileName: file.originalname,
          fileUrl: `/uploads/invoices/${file.filename}`,
          mimeType: file.mimetype,
          fileSize: file.size,
          kind: kindFromMime(file.mimetype),
        },
      });
      created.push(att);
    }
    res.status(201).json(created);
  } catch (e) {
    res.status(500).json({ error: 'Eroare upload' });
  }
});

router.delete('/:id/attachments/:attId', async (req, res) => {
  try {
    const att = await prisma.attachment.findUnique({ where: { id: req.params.attId } });
    if (!att || att.invoiceId !== req.params.id) return res.status(404).json({ error: 'Inexistent' });
    const inv = await prisma.invoice.findUnique({ where: { id: att.invoiceId } });
    const access = await getVehicleAccess(req.user.id, inv.vehicleId);
    if (!access.ok) return res.status(access.status).json({ error: access.error });
    if (access.role !== 'owner' && att.userId !== req.user.id) {
      return res.status(403).json({ error: 'Poți șterge doar fișierele adăugate de tine' });
    }

    const p = path.join(__dirname, '../..', att.fileUrl.replace(/^\//, ''));
    fs.unlink(p, () => {});
    await prisma.attachment.delete({ where: { id: att.id } });
    res.json({ message: 'Șters' });
  } catch (e) {
    res.status(500).json({ error: 'Eroare server' });
  }
});

module.exports = router;
