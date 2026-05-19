const prisma = require('../prisma');
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const { authMiddleware } = require('../middleware/auth');
const { audit } = require('../middleware/audit');
const { getVehicleAccess, publicUser } = require('../utils/vehicleAccess');
const {
  computeAvailability,
  checkAndNotifyAvailabilityChange,
  notifyVehicleMembers,
} = require('../utils/availability');
const { notifyUser } = require('../utils/notify');

const router = express.Router();


const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, '../../uploads')),
  filename: (req, file, cb) => cb(null, `vehicle-${Date.now()}-${Math.round(Math.random() * 1e9)}${path.extname(file.originalname)}`),
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } }).any();

router.use(authMiddleware);

function cleanupUploadedFiles(files = []) {
  files.forEach(file => fs.unlink(file.path, () => {}));
}

function notify(userId, title, body, type = 'info', relatedId, relatedType) {
  return notifyUser(userId, { title, body, type, relatedId, relatedType });
}

function vehicleWithRole(vehicle, currentUserId, members = []) {
  const isOwner = vehicle.userId === currentUserId;
  const availability = computeAvailability(vehicle);
  return {
    ...vehicle,
    isOwner,
    role: isOwner ? 'owner' : 'member',
    isShared: members.length > 0 || !isOwner,
    memberCount: members.length,
    effectiveAvailability: availability.state,
    availabilityReasons: availability.reasons,
    isEffectivelyAvailable: availability.isAvailable,
  };
}

router.get('/', async (req, res) => {
  try {
    const me = req.user.id;
    const owned = await prisma.vehicle.findMany({
      where: { userId: me },
      orderBy: { createdAt: 'desc' },
      include: { members: { select: { id: true } } },
    });
    const memberships = await prisma.vehicleMember.findMany({
      where: { userId: me },
      include: {
        vehicle: { include: { members: { select: { id: true } } } },
      },
    });

    // Verifică tranziții automate de availability (ex: ITP/RCA tocmai au expirat)
    const allRaw = [...owned, ...memberships.map(m => m.vehicle)];
    await Promise.all(allRaw.map(v => checkAndNotifyAvailabilityChange(v).catch(() => null)));

    const list = [
      ...owned.map(v => vehicleWithRole(v, me, v.members)),
      ...memberships.map(m => vehicleWithRole(m.vehicle, me, m.vehicle.members)),
    ];
    list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json(list);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Eroare server' });
  }
});

router.get('/:id', async (req, res) => {
  const access = await getVehicleAccess(req.user.id, req.params.id);
  if (!access.ok) return res.status(access.status).json({ error: access.error });
  const vehicle = await prisma.vehicle.findUnique({
    where: { id: req.params.id },
    include: { members: { select: { id: true } } },
  });
  await checkAndNotifyAvailabilityChange(vehicle).catch(() => null);
  res.json(vehicleWithRole(vehicle, req.user.id, vehicle.members));
});

router.post('/', upload, async (req, res) => {
  try {
    const {
      clientId, plate, brand, model, year, vin, color, km, fuel, power, category,
      itpDate, rcaDate, cascoDate, rovDate, purchaseDate, purchaseKm,
    } = req.body;
    if (!plate || !brand || !model || !year) {
      return res.status(400).json({ error: 'Număr, marcă, model și an sunt obligatorii' });
    }
    const normalizedClientId = clientId ? String(clientId) : null;
    if (normalizedClientId) {
      const existing = await prisma.vehicle.findUnique({
        where: { userId_clientId: { userId: req.user.id, clientId: normalizedClientId } },
        include: { members: { select: { id: true } } },
      });
      if (existing) {
        cleanupUploadedFiles(req.files);
        return res.json(vehicleWithRole(existing, req.user.id, existing.members));
      }
    }
    const photoFile = req.files?.[0];
    const photo = photoFile ? `/uploads/${photoFile.filename}` : null;

    // Dacă userul setează km la achiziție și nu setează km curent, folosim km de achiziție
    const initialKm = km ? parseInt(km) : (purchaseKm ? parseInt(purchaseKm) : 0);

    const vehicle = await prisma.vehicle.create({
      data: {
        clientId: normalizedClientId,
        userId: req.user.id, plate, brand, model,
        year: parseInt(year), vin, color,
        km: initialKm,
        fuel: fuel || 'Benzina',
        power: power ? parseInt(power) : null,
        photo, category: category || 'masina',
        itpDate, rcaDate, cascoDate, rovDate,
        purchaseDate: purchaseDate || null,
        purchaseKm: purchaseKm ? parseInt(purchaseKm) : null,
      },
    });
    await audit(req.user.id, 'CREATE', 'Vehicle', vehicle.id, `${brand} ${model} ${plate}`, req.ip);
    res.status(201).json(vehicleWithRole(vehicle, req.user.id, []));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Eroare server' });
  }
});

router.put('/:id', upload, async (req, res) => {
  try {
    const access = await getVehicleAccess(req.user.id, req.params.id);
    if (!access.ok) return res.status(access.status).json({ error: access.error });
    if (access.role !== 'owner') return res.status(403).json({ error: 'Doar proprietarul poate edita vehiculul' });

    const {
      plate, brand, model, year, vin, color, km, fuel, power, category,
      itpDate, rcaDate, cascoDate, rovDate, purchaseDate, purchaseKm,
    } = req.body;
    const photoFile = req.files?.[0];
    const photo = photoFile ? `/uploads/${photoFile.filename}` : undefined;
    const updated = await prisma.vehicle.update({
      where: { id: req.params.id },
      data: {
        plate: plate || undefined, brand: brand || undefined, model: model || undefined,
        year: year ? parseInt(year) : undefined, vin: vin !== undefined ? vin : undefined,
        color: color !== undefined ? color : undefined, km: km ? parseInt(km) : undefined,
        fuel: fuel || undefined, power: power ? parseInt(power) : undefined,
        ...(photo !== undefined ? { photo } : {}),
        category: category || undefined,
        itpDate: itpDate !== undefined ? itpDate : undefined,
        rcaDate: rcaDate !== undefined ? rcaDate : undefined,
        cascoDate: cascoDate !== undefined ? cascoDate : undefined,
        rovDate: rovDate !== undefined ? rovDate : undefined,
        purchaseDate: purchaseDate !== undefined ? (purchaseDate || null) : undefined,
        purchaseKm: purchaseKm !== undefined ? (purchaseKm ? parseInt(purchaseKm) : null) : undefined,
      },
      include: { members: { select: { id: true } } },
    });
    await checkAndNotifyAvailabilityChange(updated).catch(() => null);
    const fresh = await prisma.vehicle.findUnique({
      where: { id: updated.id },
      include: { members: { select: { id: true } } },
    });
    await audit(req.user.id, 'UPDATE', 'Vehicle', updated.id, null, req.ip);
    res.json(vehicleWithRole(fresh, req.user.id, fresh.members));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Eroare server' });
  }
});

// ── Availability switch ──────────────────────────────────────────────────────

router.put('/:id/availability', async (req, res) => {
  try {
    const access = await getVehicleAccess(req.user.id, req.params.id);
    if (!access.ok) return res.status(access.status).json({ error: access.error });
    if (access.role !== 'owner') {
      return res.status(403).json({ error: 'Doar proprietarul poate schimba disponibilitatea' });
    }

    const { isAvailable, unavailableReason, unavailableFrom, unavailableUntil } = req.body;
    const updated = await prisma.vehicle.update({
      where: { id: req.params.id },
      data: {
        isAvailable: isAvailable !== undefined ? !!isAvailable : undefined,
        unavailableReason: unavailableReason !== undefined ? (unavailableReason || null) : undefined,
        unavailableFrom: unavailableFrom !== undefined ? (unavailableFrom || null) : undefined,
        unavailableUntil: unavailableUntil !== undefined ? (unavailableUntil || null) : undefined,
      },
      include: { members: { select: { id: true } } },
    });

    await checkAndNotifyAvailabilityChange(updated).catch(() => null);
    const fresh = await prisma.vehicle.findUnique({
      where: { id: updated.id },
      include: { members: { select: { id: true } } },
    });
    await audit(req.user.id, 'UPDATE_AVAILABILITY', 'Vehicle', updated.id, `isAvailable=${updated.isAvailable}`, req.ip);
    res.json(vehicleWithRole(fresh, req.user.id, fresh.members));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Eroare server' });
  }
});

// ── Statistics: km growth & expenses per month ───────────────────────────────

router.get('/:id/stats', async (req, res) => {
  try {
    const access = await getVehicleAccess(req.user.id, req.params.id);
    if (!access.ok) return res.status(access.status).json({ error: access.error });

    const vehicleId = req.params.id;
    const [vehicle, fuelLogs, invoices] = await Promise.all([
      prisma.vehicle.findUnique({ where: { id: vehicleId } }),
      prisma.fuelLog.findMany({ where: { vehicleId }, orderBy: { date: 'asc' } }),
      prisma.invoice.findMany({ where: { vehicleId }, orderBy: { date: 'asc' } }),
    ]);

    // Build month buckets from purchase date (or first record) to now
    const monthsMap = new Map();

    function monthKey(dateStr) {
      const d = new Date(dateStr);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    }
    function ensureMonth(key) {
      if (!monthsMap.has(key)) {
        monthsMap.set(key, {
          month: key,
          kmStart: null,
          kmEnd: null,
          kmDelta: 0,
          fuelLiters: 0,
          fuelCost: 0,
          invoiceCost: 0,
          totalCost: 0,
          entries: 0,
        });
      }
      return monthsMap.get(key);
    }

    // Collect km readings per month from fuel + invoice
    const kmEvents = [];
    if (vehicle.purchaseDate && vehicle.purchaseKm != null) {
      kmEvents.push({ date: vehicle.purchaseDate, km: vehicle.purchaseKm });
    }
    fuelLogs.forEach(f => {
      if (f.km) kmEvents.push({ date: f.date, km: f.km });
    });
    invoices.forEach(i => {
      if (i.km) kmEvents.push({ date: i.date, km: i.km });
    });
    kmEvents.sort((a, b) => a.date.localeCompare(b.date));

    // Update monthly km
    kmEvents.forEach(ev => {
      const key = monthKey(ev.date);
      const bucket = ensureMonth(key);
      if (bucket.kmStart === null || ev.km < bucket.kmStart) bucket.kmStart = ev.km;
      if (bucket.kmEnd === null || ev.km > bucket.kmEnd) bucket.kmEnd = ev.km;
      bucket.entries += 1;
    });

    // Fuel + invoice costs per month
    fuelLogs.forEach(f => {
      const key = monthKey(f.date);
      const bucket = ensureMonth(key);
      bucket.fuelLiters += Number(f.liters || 0);
      bucket.fuelCost += Number(f.total || 0);
    });
    invoices.forEach(i => {
      const key = monthKey(i.date);
      const bucket = ensureMonth(key);
      bucket.invoiceCost += Number(i.amount || 0);
    });

    // Compute kmDelta and totalCost per month, also chain across months
    const sortedKeys = [...monthsMap.keys()].sort();
    let runningKm = null;
    sortedKeys.forEach(key => {
      const bucket = monthsMap.get(key);
      if (bucket.kmStart === null) {
        // No km event this month — carry over
        bucket.kmStart = runningKm;
        bucket.kmEnd = runningKm;
        bucket.kmDelta = 0;
      } else {
        if (runningKm !== null && bucket.kmStart > runningKm) {
          bucket.kmDelta = bucket.kmEnd - runningKm;
        } else {
          bucket.kmDelta = bucket.kmEnd - bucket.kmStart;
        }
        runningKm = bucket.kmEnd;
      }
      bucket.totalCost = bucket.fuelCost + bucket.invoiceCost;
    });

    const series = sortedKeys.map(k => monthsMap.get(k));

    // Totaluri
    const total = series.reduce(
      (acc, m) => ({
        kmDelta: acc.kmDelta + (m.kmDelta || 0),
        fuelLiters: acc.fuelLiters + m.fuelLiters,
        fuelCost: acc.fuelCost + m.fuelCost,
        invoiceCost: acc.invoiceCost + m.invoiceCost,
        totalCost: acc.totalCost + m.totalCost,
      }),
      { kmDelta: 0, fuelLiters: 0, fuelCost: 0, invoiceCost: 0, totalCost: 0 },
    );

    res.json({
      vehicleId,
      purchaseDate: vehicle.purchaseDate,
      purchaseKm: vehicle.purchaseKm,
      currentKm: vehicle.km,
      months: series,
      total,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Eroare server' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const access = await getVehicleAccess(req.user.id, req.params.id);
    if (!access.ok) return res.status(access.status).json({ error: access.error });
    if (access.role !== 'owner') return res.status(403).json({ error: 'Doar proprietarul poate șterge vehiculul' });

    const v = await prisma.vehicle.findUnique({ where: { id: req.params.id } });
    await prisma.vehicle.delete({ where: { id: req.params.id } });
    await audit(req.user.id, 'DELETE', 'Vehicle', req.params.id, `${v.brand} ${v.model} ${v.plate}`, req.ip);
    res.json({ message: 'Vehicul șters' });
  } catch (e) {
    res.status(500).json({ error: 'Eroare server' });
  }
});

// ── Members ─────────────────────────────────────────────────────────────────

router.get('/:id/members', async (req, res) => {
  try {
    const access = await getVehicleAccess(req.user.id, req.params.id);
    if (!access.ok) return res.status(access.status).json({ error: access.error });

    const vehicle = await prisma.vehicle.findUnique({
      where: { id: req.params.id },
      include: {
        user: true,
        members: {
          include: { user: true, addedBy: true },
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    res.json({
      owner: publicUser(vehicle.user),
      members: vehicle.members.map(m => ({
        id: m.id,
        user: publicUser(m.user),
        addedBy: publicUser(m.addedBy),
        role: m.role,
        createdAt: m.createdAt,
      })),
    });
  } catch (e) {
    res.status(500).json({ error: 'Eroare server' });
  }
});

router.post('/:id/members', async (req, res) => {
  try {
    const me = req.user.id;
    const access = await getVehicleAccess(me, req.params.id);
    if (!access.ok) return res.status(access.status).json({ error: access.error });
    if (access.role !== 'owner') return res.status(403).json({ error: 'Doar proprietarul poate adăuga membri' });

    const { userId, email } = req.body;
    if (!userId && !email) return res.status(400).json({ error: 'userId sau email obligatoriu' });

    let target;
    if (userId) {
      target = await prisma.user.findUnique({ where: { id: userId } });
    } else {
      target = await prisma.user.findUnique({ where: { email: String(email).trim().toLowerCase() } });
    }
    if (!target) return res.status(404).json({ error: 'Utilizator inexistent' });
    if (target.id === me) return res.status(400).json({ error: 'Ești deja proprietarul' });

    const friendship = await prisma.friendship.findFirst({
      where: {
        status: 'accepted',
        OR: [
          { requesterId: me, addresseeId: target.id },
          { requesterId: target.id, addresseeId: me },
        ],
      },
    });
    if (!friendship) {
      return res.status(403).json({ error: 'Poți adăuga doar prieteni acceptați. Trimite-i o cerere de prietenie întâi.' });
    }

    const existing = await prisma.vehicleMember.findUnique({
      where: { vehicleId_userId: { vehicleId: req.params.id, userId: target.id } },
    });
    if (existing) return res.status(409).json({ error: 'Utilizator deja membru' });

    const member = await prisma.vehicleMember.create({
      data: {
        vehicleId: req.params.id,
        userId: target.id,
        addedById: me,
        role: 'member',
      },
      include: { user: true, addedBy: true },
    });

    const vehicle = await prisma.vehicle.findUnique({ where: { id: req.params.id } });
    await notify(
      target.id,
      'Acces nou la vehicul',
      `${req.user.name} ți-a dat acces la ${vehicle.brand} ${vehicle.model} (${vehicle.plate}).`,
      'info',
      vehicle.id,
      'Vehicle',
    );
    await audit(me, 'ADD_VEHICLE_MEMBER', 'Vehicle', vehicle.id, target.email, req.ip);

    res.status(201).json({
      id: member.id,
      user: publicUser(member.user),
      addedBy: publicUser(member.addedBy),
      role: member.role,
      createdAt: member.createdAt,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Eroare server' });
  }
});

router.delete('/:id/members/:userId', async (req, res) => {
  try {
    const me = req.user.id;
    const { id: vehicleId, userId: targetId } = req.params;
    const access = await getVehicleAccess(me, vehicleId);
    if (!access.ok) return res.status(access.status).json({ error: access.error });

    // Permit: owner removes anyone, OR a member removes themselves
    if (access.role !== 'owner' && targetId !== me) {
      return res.status(403).json({ error: 'Acces interzis' });
    }

    const membership = await prisma.vehicleMember.findUnique({
      where: { vehicleId_userId: { vehicleId, userId: targetId } },
    });
    if (!membership) return res.status(404).json({ error: 'Membru inexistent' });

    await prisma.vehicleMember.delete({ where: { id: membership.id } });

    const vehicle = await prisma.vehicle.findUnique({ where: { id: vehicleId } });
    if (access.role === 'owner' && targetId !== me) {
      await notify(
        targetId,
        'Acces eliminat',
        `Ți-a fost retras accesul la ${vehicle.brand} ${vehicle.model} (${vehicle.plate}).`,
        'warning',
        vehicle.id,
        'Vehicle',
      );
    }
    await audit(me, targetId === me ? 'LEAVE_VEHICLE' : 'REMOVE_VEHICLE_MEMBER', 'Vehicle', vehicleId, targetId, req.ip);

    res.json({ message: 'Eliminat' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Eroare server' });
  }
});

module.exports = router;
