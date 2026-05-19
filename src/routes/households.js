const express = require('express');
const prisma = require('../prisma');
const { authMiddleware } = require('../middleware/auth');
const { audit } = require('../middleware/audit');
const { getHouseholdAccess } = require('../utils/householdAccess');
const { notifyUser } = require('../utils/notify');

const router = express.Router();
router.use(authMiddleware);

function publicUser(u) {
  if (!u) return null;
  return { id: u.id, name: u.name, email: u.email, avatar: u.avatar };
}

function householdWithRole(household, currentUserId, members = []) {
  const isOwner = household.userId === currentUserId;
  return {
    ...household,
    isOwner,
    role: isOwner ? 'owner' : 'member',
    isShared: members.length > 0 || !isOwner,
    memberCount: members.length,
  };
}

// GET /households — owned + shared
router.get('/', async (req, res) => {
  try {
    const me = req.user.id;
    const owned = await prisma.household.findMany({
      where: { userId: me },
      orderBy: { createdAt: 'desc' },
      include: { members: { select: { id: true } } },
    });
    const memberships = await prisma.householdMember.findMany({
      where: { userId: me },
      include: {
        household: { include: { members: { select: { id: true } } } },
      },
    });
    const list = [
      ...owned.map(h => householdWithRole(h, me, h.members)),
      ...memberships.map(m => householdWithRole(m.household, me, m.household.members)),
    ];
    list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json(list);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Eroare server' });
  }
});

router.get('/:id', async (req, res) => {
  const access = await getHouseholdAccess(req.user.id, req.params.id);
  if (!access.ok) return res.status(access.status).json({ error: access.error });
  const household = await prisma.household.findUnique({
    where: { id: req.params.id },
    include: { members: { select: { id: true } } },
  });
  res.json(householdWithRole(household, req.user.id, household.members));
});

router.post('/', async (req, res) => {
  try {
    const { clientId, name, address, type, rooms, surface, monthlyBudget } = req.body;
    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: 'Numele locuinței este obligatoriu' });
    }
    const normalizedClientId = clientId ? String(clientId) : null;
    if (normalizedClientId) {
      const existing = await prisma.household.findUnique({
        where: { userId_clientId: { userId: req.user.id, clientId: normalizedClientId } },
        include: { members: { select: { id: true } } },
      });
      if (existing) return res.json(householdWithRole(existing, req.user.id, existing.members));
    }
    const household = await prisma.household.create({
      data: {
        clientId: normalizedClientId,
        userId: req.user.id,
        name: String(name).trim(),
        address: address || null,
        type: type || 'apartament',
        rooms: rooms ? parseInt(rooms) : null,
        surface: surface ? parseFloat(surface) : null,
        monthlyBudget: monthlyBudget ? parseFloat(monthlyBudget) : null,
      },
    });
    await audit(req.user.id, 'CREATE', 'Household', household.id, name, req.ip);
    res.status(201).json(householdWithRole(household, req.user.id, []));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Eroare server' });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const access = await getHouseholdAccess(req.user.id, req.params.id);
    if (!access.ok) return res.status(access.status).json({ error: access.error });
    if (access.role !== 'owner') return res.status(403).json({ error: 'Doar proprietarul poate edita' });

    const { name, address, type, rooms, surface, monthlyBudget, photo } = req.body;
    const updated = await prisma.household.update({
      where: { id: req.params.id },
      data: {
        name: name || undefined,
        address: address !== undefined ? (address || null) : undefined,
        type: type || undefined,
        rooms: rooms !== undefined ? (rooms ? parseInt(rooms) : null) : undefined,
        surface: surface !== undefined ? (surface ? parseFloat(surface) : null) : undefined,
        monthlyBudget: monthlyBudget !== undefined ? (monthlyBudget ? parseFloat(monthlyBudget) : null) : undefined,
        photo: photo !== undefined ? photo : undefined,
      },
      include: { members: { select: { id: true } } },
    });
    await audit(req.user.id, 'UPDATE', 'Household', updated.id, null, req.ip);
    res.json(householdWithRole(updated, req.user.id, updated.members));
  } catch (e) {
    res.status(500).json({ error: 'Eroare server' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const access = await getHouseholdAccess(req.user.id, req.params.id);
    if (!access.ok) return res.status(access.status).json({ error: access.error });
    if (access.role !== 'owner') return res.status(403).json({ error: 'Doar proprietarul poate șterge' });
    await prisma.household.delete({ where: { id: req.params.id } });
    await audit(req.user.id, 'DELETE', 'Household', req.params.id, null, req.ip);
    res.json({ message: 'Locuință ștearsă' });
  } catch (e) {
    res.status(500).json({ error: 'Eroare server' });
  }
});

// ── Members ─────────────────────────────────────────────────────────────────

router.get('/:id/members', async (req, res) => {
  try {
    const access = await getHouseholdAccess(req.user.id, req.params.id);
    if (!access.ok) return res.status(access.status).json({ error: access.error });
    const household = await prisma.household.findUnique({
      where: { id: req.params.id },
      include: {
        user: true,
        members: { include: { user: true, addedBy: true }, orderBy: { createdAt: 'asc' } },
      },
    });
    res.json({
      owner: publicUser(household.user),
      members: household.members.map(m => ({
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
    const access = await getHouseholdAccess(me, req.params.id);
    if (!access.ok) return res.status(access.status).json({ error: access.error });
    if (access.role !== 'owner') return res.status(403).json({ error: 'Doar proprietarul poate adăuga membri' });

    const { userId, email } = req.body;
    if (!userId && !email) return res.status(400).json({ error: 'userId sau email obligatoriu' });

    let target;
    if (userId) target = await prisma.user.findUnique({ where: { id: userId } });
    else target = await prisma.user.findUnique({ where: { email: String(email).trim().toLowerCase() } });
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
      return res.status(403).json({ error: 'Poți adăuga doar prieteni acceptați.' });
    }

    const existing = await prisma.householdMember.findUnique({
      where: { householdId_userId: { householdId: req.params.id, userId: target.id } },
    });
    if (existing) return res.status(409).json({ error: 'Utilizator deja membru' });

    const member = await prisma.householdMember.create({
      data: {
        householdId: req.params.id,
        userId: target.id,
        addedById: me,
      },
      include: { user: true, addedBy: true },
    });

    const household = await prisma.household.findUnique({ where: { id: req.params.id } });
    notifyUser(target.id, {
      title: 'Acces nou la locuință',
      body: `${req.user.name} ți-a dat acces la "${household.name}".`,
      type: 'info',
      relatedId: household.id,
      relatedType: 'Household',
    }).catch(() => {});

    await audit(me, 'ADD_HOUSEHOLD_MEMBER', 'Household', household.id, target.email, req.ip);

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
    const { id: householdId, userId: targetId } = req.params;
    const access = await getHouseholdAccess(me, householdId);
    if (!access.ok) return res.status(access.status).json({ error: access.error });
    if (access.role !== 'owner' && targetId !== me) {
      return res.status(403).json({ error: 'Acces interzis' });
    }
    const membership = await prisma.householdMember.findUnique({
      where: { householdId_userId: { householdId, userId: targetId } },
    });
    if (!membership) return res.status(404).json({ error: 'Membru inexistent' });
    await prisma.householdMember.delete({ where: { id: membership.id } });
    await audit(me, targetId === me ? 'LEAVE_HOUSEHOLD' : 'REMOVE_HOUSEHOLD_MEMBER', 'Household', householdId, targetId, req.ip);
    res.json({ message: 'Eliminat' });
  } catch (e) {
    res.status(500).json({ error: 'Eroare server' });
  }
});

module.exports = router;
