const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function audit(userId, action, entity, entityId, details, ip) {
  try {
    await prisma.auditLog.create({
      data: { userId, action, entity, entityId: entityId || null, details: details || null, ip: ip || null },
    });
  } catch (e) {
    console.error('Audit log error:', e.message);
  }
}

module.exports = { audit };
