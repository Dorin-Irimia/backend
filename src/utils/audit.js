// Shared Prisma include used to attach creator + last-updater info to a row.
// Plug into `include: { ...auditInclude, ...other }` on findUnique/findMany.

const USER_SELECT = { id: true, name: true, email: true, avatar: true };

const auditInclude = {
  user: { select: USER_SELECT },
  updatedBy: { select: USER_SELECT },
};

module.exports = { USER_SELECT, auditInclude };
