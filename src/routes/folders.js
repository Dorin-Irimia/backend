const express = require('express');
const prisma = require('../prisma');
const { authMiddleware } = require('../middleware/auth');
const { audit } = require('../middleware/audit');
const { getVehicleAccess, accessibleVehicleIds } = require('../utils/vehicleAccess');

const router = express.Router();
router.use(authMiddleware);

const SYSTEM_FOLDER_TEMPLATES = [
  { name: 'ITP', icon: '🔧', systemType: 'itp', sortOrder: 1 },
  { name: 'RCA', icon: '🛡️', systemType: 'rca', sortOrder: 2 },
  { name: 'CASCO', icon: '🔰', systemType: 'casco', sortOrder: 3 },
  { name: 'Rovinietă', icon: '🛣️', systemType: 'rov', sortOrder: 4 },
  { name: 'Talon și permis', icon: '🪪', systemType: 'talon', sortOrder: 5 },
  { name: 'Service și reparații', icon: '🔧', systemType: 'service', sortOrder: 6 },
  { name: 'Facturi', icon: '🧾', systemType: 'invoice', sortOrder: 7 },
  { name: 'Garanții', icon: '📋', systemType: 'warranty', sortOrder: 8 },
  { name: 'Altele', icon: '📁', systemType: 'other', sortOrder: 99 },
];

async function ensureSystemFoldersFor(userId, vehicleId) {
  const existing = await prisma.folder.findMany({
    where: { userId, vehicleId, isSystem: true },
    select: { systemType: true },
  });
  const present = new Set(existing.map(f => f.systemType));
  const missing = SYSTEM_FOLDER_TEMPLATES.filter(t => !present.has(t.systemType));
  if (missing.length === 0) return;
  await prisma.folder.createMany({
    data: missing.map(t => ({
      userId,
      vehicleId,
      name: t.name,
      icon: t.icon,
      systemType: t.systemType,
      isSystem: true,
      sortOrder: t.sortOrder,
    })),
  });
}

async function ensurePersonalSystemFolders(userId) {
  const existing = await prisma.folder.findMany({
    where: { userId, vehicleId: null, isSystem: true },
    select: { systemType: true },
  });
  const present = new Set(existing.map(f => f.systemType));
  const personalTemplates = [
    { name: 'Personale', icon: '👤', systemType: 'personal', sortOrder: 1 },
    { name: 'Altele', icon: '📁', systemType: 'other', sortOrder: 99 },
  ];
  const missing = personalTemplates.filter(t => !present.has(t.systemType));
  if (missing.length === 0) return;
  await prisma.folder.createMany({
    data: missing.map(t => ({
      userId,
      vehicleId: null,
      name: t.name,
      icon: t.icon,
      systemType: t.systemType,
      isSystem: true,
      sortOrder: t.sortOrder,
    })),
  });
}

// GET /folders?vehicleId=... or no param for all accessible
router.get('/', async (req, res) => {
  try {
    const { vehicleId } = req.query;
    const userId = req.user.id;

    if (vehicleId) {
      const access = await getVehicleAccess(userId, vehicleId);
      if (!access.ok) return res.status(access.status).json({ error: access.error });
      await ensureSystemFoldersFor(access.role === 'owner' ? userId : access.vehicle.userId, vehicleId);
      const folders = await prisma.folder.findMany({
        where: { vehicleId },
        orderBy: [{ isSystem: 'desc' }, { sortOrder: 'asc' }, { name: 'asc' }],
        include: { _count: { select: { documents: true } } },
      });
      return res.json(folders);
    }

    // All accessible
    await ensurePersonalSystemFolders(userId);
    const vehicleIds = await accessibleVehicleIds(userId);
    for (const vid of vehicleIds) {
      const v = await prisma.vehicle.findUnique({ where: { id: vid }, select: { userId: true } });
      if (v) await ensureSystemFoldersFor(v.userId, vid);
    }

    const folders = await prisma.folder.findMany({
      where: {
        OR: [
          { userId, vehicleId: null },
          { vehicleId: { in: vehicleIds } },
        ],
      },
      orderBy: [{ vehicleId: 'asc' }, { isSystem: 'desc' }, { sortOrder: 'asc' }, { name: 'asc' }],
      include: { _count: { select: { documents: true } } },
    });
    res.json(folders);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Eroare server' });
  }
});

router.post('/', async (req, res) => {
  try {
    const { clientId, name, icon, color, vehicleId } = req.body;
    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: 'Nume folder obligatoriu' });
    }

    if (vehicleId) {
      const access = await getVehicleAccess(req.user.id, vehicleId);
      if (!access.ok) return res.status(access.status).json({ error: access.error });
    }

    const normalizedClientId = clientId ? String(clientId) : null;
    if (normalizedClientId) {
      const existing = await prisma.folder.findUnique({
        where: { userId_clientId: { userId: req.user.id, clientId: normalizedClientId } },
      });
      if (existing) return res.json(existing);
    }

    const folder = await prisma.folder.create({
      data: {
        clientId: normalizedClientId,
        userId: req.user.id,
        vehicleId: vehicleId || null,
        name: String(name).trim(),
        icon: icon || '📁',
        color: color || null,
        isSystem: false,
      },
    });
    await audit(req.user.id, 'CREATE', 'Folder', folder.id, name, req.ip);
    res.status(201).json(folder);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Eroare server' });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const folder = await prisma.folder.findUnique({ where: { id: req.params.id } });
    if (!folder) return res.status(404).json({ error: 'Inexistent' });
    if (folder.userId !== req.user.id) {
      // Verify access via vehicle
      if (!folder.vehicleId) return res.status(403).json({ error: 'Acces interzis' });
      const access = await getVehicleAccess(req.user.id, folder.vehicleId);
      if (!access.ok || access.role !== 'owner') return res.status(403).json({ error: 'Acces interzis' });
    }
    if (folder.isSystem) {
      return res.status(400).json({ error: 'Folderele de sistem nu pot fi editate.' });
    }
    const { name, icon, color } = req.body;
    const updated = await prisma.folder.update({
      where: { id: req.params.id },
      data: {
        name: name !== undefined ? String(name).trim() : undefined,
        icon: icon !== undefined ? icon : undefined,
        color: color !== undefined ? color : undefined,
      },
    });
    res.json(updated);
  } catch (e) {
    res.status(500).json({ error: 'Eroare server' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const folder = await prisma.folder.findUnique({ where: { id: req.params.id }, include: { documents: true } });
    if (!folder) return res.status(404).json({ error: 'Inexistent' });
    if (folder.userId !== req.user.id) {
      if (!folder.vehicleId) return res.status(403).json({ error: 'Acces interzis' });
      const access = await getVehicleAccess(req.user.id, folder.vehicleId);
      if (!access.ok || access.role !== 'owner') return res.status(403).json({ error: 'Acces interzis' });
    }
    if (folder.isSystem) {
      return res.status(400).json({ error: 'Folderele de sistem nu pot fi șterse.' });
    }
    if (folder.documents.length > 0) {
      return res.status(400).json({ error: `Folderul conține ${folder.documents.length} document(e). Mută-le sau șterge-le mai întâi.` });
    }
    await prisma.folder.delete({ where: { id: req.params.id } });
    await audit(req.user.id, 'DELETE', 'Folder', folder.id, folder.name, req.ip);
    res.json({ message: 'Folder șters' });
  } catch (e) {
    res.status(500).json({ error: 'Eroare server' });
  }
});

module.exports = router;
module.exports.ensureSystemFoldersFor = ensureSystemFoldersFor;
module.exports.ensurePersonalSystemFolders = ensurePersonalSystemFolders;
module.exports.SYSTEM_FOLDER_TEMPLATES = SYSTEM_FOLDER_TEMPLATES;
