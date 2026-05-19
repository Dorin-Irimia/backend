const prisma = require('../prisma');

async function getHouseholdAccess(userId, householdId) {
  const household = await prisma.household.findUnique({
    where: { id: householdId },
    select: { id: true, userId: true },
  });
  if (!household) return { ok: false, status: 404, error: 'Locuință inexistentă' };
  if (household.userId === userId) return { ok: true, role: 'owner', household };
  const membership = await prisma.householdMember.findUnique({
    where: { householdId_userId: { householdId, userId } },
  });
  if (membership) return { ok: true, role: 'member', household, membership };
  return { ok: false, status: 403, error: 'Acces interzis la locuință' };
}

async function accessibleHouseholdIds(userId) {
  const [owned, shared] = await Promise.all([
    prisma.household.findMany({ where: { userId }, select: { id: true } }),
    prisma.householdMember.findMany({ where: { userId }, select: { householdId: true } }),
  ]);
  return [...owned.map(h => h.id), ...shared.map(m => m.householdId)];
}

module.exports = { getHouseholdAccess, accessibleHouseholdIds };
