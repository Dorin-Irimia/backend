const express = require('express');
const prisma = require('../prisma');
const { authMiddleware } = require('../middleware/auth');
const { accessibleVehicleIds } = require('../utils/vehicleAccess');

const router = express.Router();

router.use(authMiddleware);

function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    phone: u.phone,
    role: u.role,
    avatar: u.avatar,
    pushToken: u.pushToken,
    createdAt: u.createdAt,
    updatedAt: u.updatedAt,
  };
}

function memberUser(u) {
  if (!u) return null;
  return { id: u.id, name: u.name, email: u.email, avatar: u.avatar };
}

function vehicleWithRole(vehicle, currentUserId, members = []) {
  const isOwner = vehicle.userId === currentUserId;
  return {
    ...vehicle,
    isOwner,
    role: isOwner ? 'owner' : 'member',
    isShared: members.length > 0 || !isOwner,
    memberCount: members.length,
  };
}

router.get('/state', async (req, res) => {
  try {
    const userId = req.user.id;
    const vehicleIds = await accessibleVehicleIds(userId);

    const [
      user,
      owned,
      memberships,
      vehiclesForMembers,
      documents,
      invoices,
      reminders,
      fuelLogs,
      notifications,
      householdOwned,
      householdMemberships,
      householdExpenses,
      householdIncomes,
      householdEvents,
    ] = await Promise.all([
      prisma.user.findUnique({ where: { id: userId } }),
      prisma.vehicle.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        include: { members: { select: { id: true } } },
      }),
      prisma.vehicleMember.findMany({
        where: { userId },
        include: {
          vehicle: { include: { members: { select: { id: true } } } },
        },
      }),
      prisma.vehicle.findMany({
        where: { id: { in: vehicleIds } },
        include: {
          user: true,
          members: {
            include: { user: true, addedBy: true },
            orderBy: { createdAt: 'asc' },
          },
        },
      }),
      prisma.document.findMany({
        where: {
          OR: [
            { userId },
            { vehicleId: { in: vehicleIds } },
          ],
        },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.invoice.findMany({
        where: { vehicleId: { in: vehicleIds } },
        orderBy: { date: 'desc' },
        include: { attachments: { orderBy: { createdAt: 'asc' } } },
      }),
      prisma.reminder.findMany({
        where: {
          OR: [
            { userId },
            { vehicleId: { in: vehicleIds } },
          ],
        },
        orderBy: { dueDate: 'asc' },
      }),
      prisma.fuelLog.findMany({
        where: { vehicleId: { in: vehicleIds } },
        orderBy: { date: 'desc' },
        include: { attachments: { orderBy: { createdAt: 'asc' } } },
      }),
      prisma.notification.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
      prisma.household.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        include: { members: { select: { id: true } } },
      }),
      prisma.householdMember.findMany({
        where: { userId },
        include: {
          household: { include: { members: { select: { id: true } } } },
        },
      }),
      prisma.householdExpense.findMany({
        where: { OR: [{ userId }, { household: { members: { some: { userId } } } }] },
        orderBy: { date: 'desc' },
        include: { attachments: { orderBy: { createdAt: 'asc' } } },
      }).catch(() => []),
      prisma.householdIncome.findMany({
        where: { OR: [{ userId }, { household: { members: { some: { userId } } } }] },
        orderBy: { date: 'desc' },
      }).catch(() => []),
      prisma.householdEvent.findMany({
        where: { OR: [{ userId }, { household: { members: { some: { userId } } } }] },
        orderBy: { startDate: 'asc' },
      }).catch(() => []),
    ]);

    const vehicles = [
      ...owned.map(v => vehicleWithRole(v, userId, v.members)),
      ...memberships.map(m => vehicleWithRole(m.vehicle, userId, m.vehicle.members)),
    ].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    const vehicleMembersById = {};
    for (const vehicle of vehiclesForMembers) {
      vehicleMembersById[vehicle.id] = {
        owner: memberUser(vehicle.user),
        members: vehicle.members.map(m => ({
          id: m.id,
          user: memberUser(m.user),
          addedBy: memberUser(m.addedBy),
          role: m.role,
          createdAt: m.createdAt,
        })),
      };
    }

    const households = [
      ...householdOwned.map(h => ({
        ...h,
        isOwner: true,
        role: 'owner',
        memberCount: h.members.length,
      })),
      ...householdMemberships.map(m => ({
        ...m.household,
        isOwner: false,
        role: m.role || 'member',
        memberCount: m.household.members.length,
      })),
    ].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    res.json({
      serverTime: new Date().toISOString(),
      user: publicUser(user),
      vehicles,
      documents,
      invoices,
      reminders,
      fuelLogs,
      notifications,
      vehicleMembersById,
      households,
      householdExpenses,
      householdIncomes,
      householdEvents,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Eroare sincronizare' });
  }
});

module.exports = router;
