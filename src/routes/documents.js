const prisma = require('../prisma');
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const { authMiddleware } = require('../middleware/auth');
const { audit } = require('../middleware/audit');
const { getVehicleAccess, accessibleVehicleIds } = require('../utils/vehicleAccess');
const { notifyVehicleMembers } = require('../utils/notify');

const router = express.Router();

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, '../../uploads/documents');
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    const ext = path.extname(file.originalname) || '';
    cb(null, `${unique}${ext}`);
  },
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } }).any();

router.use(authMiddleware);

function cleanupUploadedFiles(files = []) {
  files.forEach(f => fs.unlink(f.path, () => {}));
}

// Mapping intern: legacy `type` ↔ Folder.systemType ↔ Vehicle.<dateField>
const SYSTEM_TYPE_TO_VEHICLE_FIELD = {
  itp: 'itpDate',
  rca: 'rcaDate',
  casco: 'cascoDate',
  rov: 'rovDate',
};
const TYPE_ALIAS_TO_SYSTEM = {
  itp: 'itp',
  rca: 'rca',
  casco: 'casco',
  rovinieta: 'rov',
  'rovinietă': 'rov',
  rov: 'rov',
  talon: 'talon',
  factura: 'invoice',
  'factură': 'invoice',
  garantie: 'warranty',
  'garanție': 'warranty',
  service: 'service',
};
function normalizeTypeToSystem(rawType) {
  if (!rawType) return 'other';
  const k = String(rawType).toLowerCase().trim();
  return TYPE_ALIAS_TO_SYSTEM[k] || (Object.values(TYPE_ALIAS_TO_SYSTEM).includes(k) ? k : 'other');
}

async function inferFolderFromType(userId, vehicleId, systemType) {
  if (!systemType || systemType === 'other') {
    const f = await prisma.folder.findFirst({
      where: { vehicleId: vehicleId || null, userId, isSystem: true, systemType: 'other' },
    });
    return f?.id || null;
  }
  const f = await prisma.folder.findFirst({
    where: { vehicleId: vehicleId || null, isSystem: true, systemType },
  });
  return f?.id || null;
}

router.get('/', async (req, res) => {
  try {
    const { vehicleId, folderId } = req.query;
    const userId = req.user.id;

    if (folderId) {
      const folder = await prisma.folder.findUnique({ where: { id: folderId } });
      if (!folder) return res.status(404).json({ error: 'Folder inexistent' });
      if (folder.vehicleId) {
        const access = await getVehicleAccess(userId, folder.vehicleId);
        if (!access.ok) return res.status(access.status).json({ error: access.error });
      } else if (folder.userId !== userId) {
        return res.status(403).json({ error: 'Acces interzis' });
      }
      const docs = await prisma.document.findMany({
        where: { folderId },
        orderBy: { createdAt: 'desc' },
      });
      return res.json(docs);
    }

    if (vehicleId) {
      const access = await getVehicleAccess(userId, vehicleId);
      if (!access.ok) return res.status(access.status).json({ error: access.error });
      const docs = await prisma.document.findMany({
        where: { vehicleId },
        orderBy: { createdAt: 'desc' },
      });
      return res.json(docs);
    }

    const vehicleIds = await accessibleVehicleIds(userId);
    const docs = await prisma.document.findMany({
      where: {
        OR: [
          { userId },
          { vehicleId: { in: vehicleIds } },
        ],
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json(docs);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Eroare server' });
  }
});

router.get('/:id', async (req, res) => {
  const doc = await prisma.document.findUnique({ where: { id: req.params.id } });
  if (!doc) return res.status(404).json({ error: 'Document negăsit' });

  let allowed = doc.userId === req.user.id;
  if (!allowed && doc.vehicleId) {
    const access = await getVehicleAccess(req.user.id, doc.vehicleId);
    allowed = access.ok;
  }
  if (!allowed) return res.status(403).json({ error: 'Acces interzis' });
  res.json(doc);
});

router.post('/', upload, async (req, res) => {
  try {
    const { clientId, name, type, folderId, vehicleId, expiryDate, notes } = req.body;
    if (!name) return res.status(400).json({ error: 'Numele este obligatoriu' });

    const normalizedClientId = clientId ? String(clientId) : null;
    if (normalizedClientId) {
      const existing = await prisma.document.findUnique({
        where: { userId_clientId: { userId: req.user.id, clientId: normalizedClientId } },
      });
      if (existing) {
        cleanupUploadedFiles(req.files);
        return res.json(existing);
      }
    }

    if (vehicleId) {
      const access = await getVehicleAccess(req.user.id, vehicleId);
      if (!access.ok) return res.status(access.status).json({ error: access.error });
    }

    // Resolve folder
    let resolvedFolderId = folderId || null;
    let resolvedSystemType = normalizeTypeToSystem(type);
    if (!resolvedFolderId) {
      resolvedFolderId = await inferFolderFromType(req.user.id, vehicleId || null, resolvedSystemType);
    } else {
      // If folder is given, sync the type/systemType from folder
      const folder = await prisma.folder.findUnique({ where: { id: resolvedFolderId } });
      if (folder?.systemType) resolvedSystemType = folder.systemType;
    }

    const uploadedFile = req.files && req.files[0];
    const fileUrl = uploadedFile ? `/uploads/documents/${uploadedFile.filename}` : null;

    const doc = await prisma.document.create({
      data: {
        clientId: normalizedClientId,
        userId: req.user.id,
        vehicleId: vehicleId || null,
        folderId: resolvedFolderId,
        name,
        type: resolvedSystemType,
        fileUrl,
        fileName: uploadedFile?.originalname || null,
        mimeType: uploadedFile?.mimetype || null,
        fileSize: uploadedFile?.size || null,
        expiryDate: expiryDate || null,
        notes: notes || null,
      },
    });

    // Verifică dacă trebuie sugerată actualizarea datei din vehicul
    let suggestedUpdate = null;
    if (vehicleId && expiryDate && SYSTEM_TYPE_TO_VEHICLE_FIELD[resolvedSystemType]) {
      const vehField = SYSTEM_TYPE_TO_VEHICLE_FIELD[resolvedSystemType];
      const vehicle = await prisma.vehicle.findUnique({ where: { id: vehicleId } });
      const currentDate = vehicle?.[vehField] || null;
      if (!currentDate || String(expiryDate) > String(currentDate)) {
        suggestedUpdate = {
          field: vehField,
          systemType: resolvedSystemType,
          oldDate: currentDate,
          newDate: expiryDate,
          vehiclePlate: vehicle?.plate,
        };
      }
    }

    await audit(req.user.id, 'CREATE', 'Document', doc.id, name, req.ip);

    // Notifică membrii vehiculului (exclus pe cel care a încărcat)
    if (vehicleId) {
      const vehicle = await prisma.vehicle.findUnique({ where: { id: vehicleId }, select: { plate: true } });
      const typeLabel = {
        itp: '🔧 ITP', rca: '🛡️ RCA', casco: '🔰 CASCO',
        rov: '🛣️ Rovinietă', talon: '🪪 Talon', service: '🔧 Service',
        invoice: '🧾 Factură', warranty: '📋 Garanție',
      }[resolvedSystemType] || '📄 Document';
      notifyVehicleMembers(vehicleId, req.user.id, {
        title: `${typeLabel} nou`,
        body: `${req.user.name} a încărcat "${name}" pentru ${vehicle?.plate || 'vehicul'}.`,
        type: 'info',
        relatedId: doc.id,
        relatedType: 'Document',
      }).catch(() => {});
    }

    res.status(201).json({ ...doc, _suggestedVehicleUpdate: suggestedUpdate });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Eroare server' });
  }
});

router.put('/:id', upload, async (req, res) => {
  try {
    const doc = await prisma.document.findUnique({ where: { id: req.params.id } });
    if (!doc) return res.status(404).json({ error: 'Inexistent' });

    let allowed = doc.userId === req.user.id;
    if (!allowed && doc.vehicleId) {
      const access = await getVehicleAccess(req.user.id, doc.vehicleId);
      allowed = access.ok && access.role === 'owner';
    }
    if (!allowed) return res.status(403).json({ error: 'Acces interzis' });

    const { name, folderId, type, expiryDate, notes } = req.body;
    const uploadedFile = req.files && req.files[0];

    let updates = {
      name: name !== undefined ? name : undefined,
      folderId: folderId !== undefined ? (folderId || null) : undefined,
      expiryDate: expiryDate !== undefined ? (expiryDate || null) : undefined,
      notes: notes !== undefined ? (notes || null) : undefined,
    };

    if (folderId) {
      const folder = await prisma.folder.findUnique({ where: { id: folderId } });
      if (folder?.systemType) updates.type = folder.systemType;
    } else if (type !== undefined) {
      updates.type = normalizeTypeToSystem(type);
    }

    if (uploadedFile) {
      if (doc.fileUrl) {
        const oldPath = path.join(__dirname, '../..', doc.fileUrl.replace(/^\//, ''));
        fs.unlink(oldPath, () => {});
      }
      updates.fileUrl = `/uploads/documents/${uploadedFile.filename}`;
      updates.fileName = uploadedFile.originalname;
      updates.mimeType = uploadedFile.mimetype;
      updates.fileSize = uploadedFile.size;
    }

    const updated = await prisma.document.update({
      where: { id: req.params.id },
      data: updates,
    });

    // Recompute suggestion if expiry changed and vehicle is set
    let suggestedUpdate = null;
    if (doc.vehicleId && updates.expiryDate && SYSTEM_TYPE_TO_VEHICLE_FIELD[updated.type]) {
      const vehField = SYSTEM_TYPE_TO_VEHICLE_FIELD[updated.type];
      const vehicle = await prisma.vehicle.findUnique({ where: { id: doc.vehicleId } });
      const currentDate = vehicle?.[vehField] || null;
      if (!currentDate || String(updates.expiryDate) > String(currentDate)) {
        suggestedUpdate = {
          field: vehField,
          systemType: updated.type,
          oldDate: currentDate,
          newDate: updates.expiryDate,
          vehiclePlate: vehicle?.plate,
        };
      }
    }

    res.json({ ...updated, _suggestedVehicleUpdate: suggestedUpdate });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Eroare server' });
  }
});

router.put('/:id/sign', async (req, res) => {
  try {
    const doc = await prisma.document.findFirst({ where: { id: req.params.id, userId: req.user.id } });
    if (!doc) return res.status(404).json({ error: 'Document negăsit' });
    const { signatureData } = req.body;
    const updated = await prisma.document.update({
      where: { id: req.params.id },
      data: { isSigned: true, signatureData, signedUrl: doc.fileUrl },
    });
    await audit(req.user.id, 'SIGN', 'Document', doc.id, doc.name, req.ip);
    res.json(updated);
  } catch (e) {
    res.status(500).json({ error: 'Eroare server' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const doc = await prisma.document.findUnique({ where: { id: req.params.id } });
    if (!doc) return res.status(404).json({ error: 'Document negăsit' });

    let allowed = doc.userId === req.user.id;
    if (!allowed && doc.vehicleId) {
      const access = await getVehicleAccess(req.user.id, doc.vehicleId);
      allowed = access.ok && access.role === 'owner';
    }
    if (!allowed) return res.status(403).json({ error: 'Acces interzis' });

    if (doc.fileUrl) {
      const p = path.join(__dirname, '../..', doc.fileUrl.replace(/^\//, ''));
      fs.unlink(p, () => {});
    }

    await prisma.document.delete({ where: { id: req.params.id } });
    await audit(req.user.id, 'DELETE', 'Document', req.params.id, doc.name, req.ip);
    res.json({ message: 'Document șters' });
  } catch (e) {
    res.status(500).json({ error: 'Eroare server' });
  }
});

module.exports = router;
