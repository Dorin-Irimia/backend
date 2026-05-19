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
    const dir = path.join(__dirname, '../../uploads/fuel');
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) =>
    cb(null, `fuel-${Date.now()}-${Math.round(Math.random() * 1e9)}${path.extname(file.originalname) || ''}`),
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
  try { return JSON.parse(raw); } catch { return null; }
}

function cleanupUploadedFiles(files = []) {
  files.forEach(file => fs.unlink(file.path, () => {}));
}

function notifyMembers(vehicleId, excludeUserId, title, body) {
  return notifyVehicleMembers(vehicleId, excludeUserId, { title, body, type: 'info' });
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
    const logs = await prisma.fuelLog.findMany({
      where: { vehicleId: { in: allowedIds } },
      orderBy: { date: 'desc' },
      include: { ...auditInclude, attachments: { orderBy: { createdAt: 'asc' } } },
    });
    res.json(logs);
  } catch (e) {
    res.status(500).json({ error: 'Eroare server' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const log = await prisma.fuelLog.findUnique({
      where: { id: req.params.id },
      include: { attachments: true },
    });
    if (!log) return res.status(404).json({ error: 'Inexistent' });
    const access = await getVehicleAccess(req.user.id, log.vehicleId);
    if (!access.ok) return res.status(access.status).json({ error: access.error });
    res.json(log);
  } catch (e) {
    res.status(500).json({ error: 'Eroare server' });
  }
});

router.post('/', upload, async (req, res) => {
  try {
    const {
      clientId, vehicleId, date, time, liters, pricePerL, km, station, location,
      fuelType, fullTank, notes, customFields,
      syncToHouseholdId, syncCategory,
    } = req.body;
    if (!vehicleId || !date || !liters || !pricePerL || !km) {
      return res.status(400).json({ error: 'Vehicul, dată, litri, preț/L și km sunt obligatorii' });
    }
    const normalizedClientId = clientId ? String(clientId) : null;
    if (normalizedClientId) {
      const existing = await prisma.fuelLog.findUnique({
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

    const total = parseFloat(liters) * parseFloat(pricePerL);
    const log = await prisma.fuelLog.create({
      data: {
        clientId: normalizedClientId,
        userId: req.user.id,
        vehicleId,
        date,
        time: time || null,
        liters: parseFloat(liters),
        pricePerL: parseFloat(pricePerL),
        total,
        km: parseInt(km),
        station: station || null,
        location: location || null,
        fuelType: fuelType || null,
        fullTank: fullTank === 'false' ? false : (fullTank !== false),
        notes: notes || null,
        customFields: parseCustomFields(customFields),
      },
    });

    for (const file of req.files || []) {
      await prisma.attachment.create({
        data: {
          userId: req.user.id,
          fuelLogId: log.id,
          fileName: file.originalname,
          fileUrl: `/uploads/fuel/${file.filename}`,
          mimeType: file.mimetype,
          fileSize: file.size,
          kind: kindFromMime(file.mimetype),
        },
      });
    }

    await maybeUpdateVehicleKm(vehicleId, km);

    // Optional household sync — create a linked HouseholdExpense.
    if (syncToHouseholdId) {
      try {
        const hhAccess = await getHouseholdAccess(req.user.id, syncToHouseholdId);
        if (hhAccess.ok) {
          const vehicle = await prisma.vehicle.findUnique({ where: { id: vehicleId } });
          const exp = await prisma.householdExpense.create({
            data: {
              userId: req.user.id,
              householdId: syncToHouseholdId,
              title: `Alimentare ${station || ''}`.trim() + ` · ${vehicle?.plate || 'mașină'}`,
              amount: total,
              currency: 'RON',
              category: syncCategory || 'transport',
              date,
              time: time || null,
              merchant: station || null,
              location: location || null,
              notes: `Sincronizat din alimentări · ${parseFloat(liters).toFixed(1)}L`,
              source: 'fuel',
              sourceId: log.id,
            },
          });
          await prisma.fuelLog.update({
            where: { id: log.id },
            data: { linkedHouseholdExpenseId: exp.id },
          });
        }
      } catch (syncErr) {
        console.error('fuel → household sync failed:', syncErr.message);
      }
    }

    await audit(req.user.id, 'CREATE', 'FuelLog', log.id, `${liters}L la ${date}`, req.ip);

    if (access.role === 'member') {
      const vehicle = await prisma.vehicle.findUnique({ where: { id: vehicleId } });
      await notifyMembers(
        vehicleId,
        req.user.id,
        'Alimentare nouă',
        `${req.user.name} a alimentat ${parseFloat(liters).toFixed(1)}L (${total.toFixed(2)} RON) pentru ${vehicle.plate}.`,
      );
    }

    const fresh = await prisma.fuelLog.findUnique({
      where: { id: log.id },
      include: { ...auditInclude, attachments: true },
    });
    res.status(201).json(fresh);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Eroare server' });
  }
});

router.put('/:id', upload, async (req, res) => {
  try {
    const log = await prisma.fuelLog.findUnique({ where: { id: req.params.id } });
    if (!log) return res.status(404).json({ error: 'Inexistent' });
    const access = await getVehicleAccess(req.user.id, log.vehicleId);
    if (!access.ok) return res.status(access.status).json({ error: access.error });
    if (access.role !== 'owner' && log.userId !== req.user.id) {
      return res.status(403).json({ error: 'Poți edita doar înregistrările tale' });
    }

    const {
      date, time, liters, pricePerL, km, station, location,
      fuelType, fullTank, notes, customFields,
    } = req.body;

    let total;
    if (liters !== undefined || pricePerL !== undefined) {
      total = (liters !== undefined ? parseFloat(liters) : log.liters) *
              (pricePerL !== undefined ? parseFloat(pricePerL) : log.pricePerL);
    }

    const updated = await prisma.fuelLog.update({
      where: { id: req.params.id },
      data: {
        date: date || undefined,
        time: time !== undefined ? (time || null) : undefined,
        liters: liters !== undefined ? parseFloat(liters) : undefined,
        pricePerL: pricePerL !== undefined ? parseFloat(pricePerL) : undefined,
        total: total !== undefined ? total : undefined,
        km: km !== undefined ? parseInt(km) : undefined,
        station: station !== undefined ? (station || null) : undefined,
        location: location !== undefined ? (location || null) : undefined,
        fuelType: fuelType !== undefined ? (fuelType || null) : undefined,
        fullTank: fullTank !== undefined ? (fullTank !== false && fullTank !== 'false') : undefined,
        notes: notes !== undefined ? (notes || null) : undefined,
        customFields: customFields !== undefined ? parseCustomFields(customFields) : undefined,
        updatedById: req.user.id,
      },
    });

    if (log.linkedHouseholdExpenseId && (total !== undefined || date !== undefined)) {
      try {
        await prisma.householdExpense.update({
          where: { id: log.linkedHouseholdExpenseId },
          data: {
            amount: total !== undefined ? total : undefined,
            date: date || undefined,
            updatedById: req.user.id,
          },
        });
      } catch {}
    }

    if (km !== undefined) {
      await maybeUpdateVehicleKm(log.vehicleId, km);
    }

    for (const file of req.files || []) {
      await prisma.attachment.create({
        data: {
          userId: req.user.id,
          fuelLogId: updated.id,
          fileName: file.originalname,
          fileUrl: `/uploads/fuel/${file.filename}`,
          mimeType: file.mimetype,
          fileSize: file.size,
          kind: kindFromMime(file.mimetype),
        },
      });
    }

    const fresh = await prisma.fuelLog.findUnique({
      where: { id: updated.id },
      include: { ...auditInclude, attachments: true },
    });
    await audit(req.user.id, 'UPDATE', 'FuelLog', updated.id, null, req.ip);
    res.json(fresh);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Eroare server' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const log = await prisma.fuelLog.findUnique({
      where: { id: req.params.id },
      include: { attachments: true },
    });
    if (!log) return res.status(404).json({ error: 'Înregistrare negăsită' });
    const access = await getVehicleAccess(req.user.id, log.vehicleId);
    if (!access.ok) return res.status(access.status).json({ error: access.error });
    if (access.role !== 'owner' && log.userId !== req.user.id) {
      return res.status(403).json({ error: 'Poți șterge doar înregistrările tale' });
    }
    log.attachments.forEach(a => {
      const p = path.join(__dirname, '../..', a.fileUrl.replace(/^\//, ''));
      fs.unlink(p, () => {});
    });
    if (log.linkedHouseholdExpenseId) {
      try { await prisma.householdExpense.delete({ where: { id: log.linkedHouseholdExpenseId } }); } catch {}
    }
    await prisma.fuelLog.delete({ where: { id: req.params.id } });
    res.json({ message: 'Înregistrare ștearsă' });
  } catch (e) {
    res.status(500).json({ error: 'Eroare server' });
  }
});

// Attachment endpoints
router.post('/:id/attachments', upload, async (req, res) => {
  try {
    const log = await prisma.fuelLog.findUnique({ where: { id: req.params.id } });
    if (!log) return res.status(404).json({ error: 'Inexistent' });
    const access = await getVehicleAccess(req.user.id, log.vehicleId);
    if (!access.ok) return res.status(access.status).json({ error: access.error });

    const created = [];
    for (const file of req.files || []) {
      const att = await prisma.attachment.create({
        data: {
          userId: req.user.id,
          fuelLogId: log.id,
          fileName: file.originalname,
          fileUrl: `/uploads/fuel/${file.filename}`,
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
    if (!att || att.fuelLogId !== req.params.id) return res.status(404).json({ error: 'Inexistent' });
    const log = await prisma.fuelLog.findUnique({ where: { id: att.fuelLogId } });
    const access = await getVehicleAccess(req.user.id, log.vehicleId);
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
