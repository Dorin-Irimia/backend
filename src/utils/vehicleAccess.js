const prisma = require('../prisma');

async function getVehicleAccess(userId, vehicleId) {
  const vehicle = await prisma.vehicle.findUnique({
    where: { id: vehicleId },
    select: { id: true, userId: true },
  });
  if (!vehicle) return { ok: false, status: 404, error: 'Vehicul inexistent' };
  if (vehicle.userId === userId) return { ok: true, role: 'owner', vehicle };
  const membership = await prisma.vehicleMember.findUnique({
    where: { vehicleId_userId: { vehicleId, userId } },
  });
  if (membership) return { ok: true, role: 'member', vehicle, membership };
  return { ok: false, status: 403, error: 'Acces interzis' };
}

async function accessibleVehicleIds(userId) {
  const [owned, shared] = await Promise.all([
    prisma.vehicle.findMany({ where: { userId }, select: { id: true } }),
    prisma.vehicleMember.findMany({ where: { userId }, select: { vehicleId: true } }),
  ]);
  return [...owned.map(v => v.id), ...shared.map(m => m.vehicleId)];
}

function requireOwner(access) {
  return access.ok && access.role === 'owner';
}

function publicUser(u) {
  if (!u) return null;
  return { id: u.id, name: u.name, email: u.email, avatar: u.avatar };
}

module.exports = { getVehicleAccess, accessibleVehicleIds, requireOwner, publicUser };
