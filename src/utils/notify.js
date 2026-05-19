const prisma = require('../prisma');
const { sendPush } = require('./push');

/**
 * Creează o notificare în DB ȘI trimite push (dacă userul are token).
 * Apelul nu eșuează main flow-ul dacă pushul nu reușește.
 */
async function notifyUser(userId, { title, body, type = 'info', relatedId, relatedType, data }) {
  if (!userId) return null;
  try {
    const notification = await prisma.notification.create({
      data: {
        userId,
        title,
        body,
        type,
        relatedId: relatedId || null,
        relatedType: relatedType || null,
      },
    });

    // Fetch token & trimit push
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { pushToken: true },
    });
    if (user?.pushToken) {
      sendPush(user.pushToken, {
        title,
        body,
        data: {
          notificationId: notification.id,
          type,
          relatedId,
          relatedType,
          ...data,
        },
      }).catch(() => {});
    }
    return notification;
  } catch (e) {
    console.error('notifyUser error:', e.message);
    return null;
  }
}

/**
 * Notifică toți membrii unui vehicul (owner + shared users), exclusiv pe cel care a făcut acțiunea.
 */
async function notifyVehicleMembers(vehicleId, excludeUserId, payload) {
  if (!vehicleId) return;
  try {
    const vehicle = await prisma.vehicle.findUnique({
      where: { id: vehicleId },
      include: { members: { select: { userId: true } } },
    });
    if (!vehicle) return;
    const userIds = new Set([vehicle.userId, ...vehicle.members.map(m => m.userId)]);
    if (excludeUserId) userIds.delete(excludeUserId);

    const recipients = [...userIds];
    if (recipients.length === 0) return;

    // Pre-load all push tokens in batch
    const users = await prisma.user.findMany({
      where: { id: { in: recipients } },
      select: { id: true, pushToken: true },
    });

    // Create notifications in DB
    await prisma.notification.createMany({
      data: recipients.map(uid => ({
        userId: uid,
        title: payload.title,
        body: payload.body,
        type: payload.type || 'info',
        relatedId: payload.relatedId || vehicleId,
        relatedType: payload.relatedType || 'Vehicle',
      })),
    });

    // Send pushes in parallel
    const tokens = users.map(u => u.pushToken).filter(Boolean);
    if (tokens.length > 0) {
      sendPush(tokens, {
        title: payload.title,
        body: payload.body,
        data: {
          type: payload.type || 'info',
          relatedId: payload.relatedId || vehicleId,
          relatedType: payload.relatedType || 'Vehicle',
          ...(payload.data || {}),
        },
      }).catch(() => {});
    }
  } catch (e) {
    console.error('notifyVehicleMembers error:', e.message);
  }
}

module.exports = { notifyUser, notifyVehicleMembers };
