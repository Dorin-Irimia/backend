const express = require('express');
const prisma = require('../prisma');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();
router.use(authMiddleware);

async function ensureFriendship(userA, userB) {
  if (userA === userB) return false;
  const friend = await prisma.friendship.findFirst({
    where: {
      status: 'accepted',
      OR: [
        { requesterId: userA, addresseeId: userB },
        { requesterId: userB, addresseeId: userA },
      ],
    },
    select: { id: true },
  });
  return !!friend;
}

// List recent conversations (one row per friend) — for inbox/UX.
router.get('/threads', async (req, res) => {
  try {
    const me = req.user.id;
    const friends = await prisma.friendship.findMany({
      where: { status: 'accepted', OR: [{ requesterId: me }, { addresseeId: me }] },
      include: {
        requester: { select: { id: true, name: true, email: true, avatar: true } },
        addressee: { select: { id: true, name: true, email: true, avatar: true } },
      },
    });

    const threads = [];
    for (const f of friends) {
      const other = f.requesterId === me ? f.addressee : f.requester;
      const lastMsg = await prisma.chatMessage.findFirst({
        where: {
          OR: [
            { fromUserId: me, toUserId: other.id },
            { fromUserId: other.id, toUserId: me },
          ],
        },
        orderBy: { createdAt: 'desc' },
      });
      const unread = await prisma.chatMessage.count({
        where: { fromUserId: other.id, toUserId: me, readAt: null },
      });
      threads.push({
        friend: other,
        lastMessage: lastMsg,
        unread,
        updatedAt: lastMsg?.createdAt || f.updatedAt,
      });
    }
    threads.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    res.json(threads);
  } catch (e) {
    console.error('chat threads:', e);
    res.status(500).json({ error: 'Eroare server' });
  }
});

// Get conversation history with one friend
router.get('/:friendId/messages', async (req, res) => {
  try {
    const me = req.user.id;
    const friendId = req.params.friendId;
    const ok = await ensureFriendship(me, friendId);
    if (!ok) return res.status(403).json({ error: 'Nu sunteți prieteni' });

    const { before, take } = req.query;
    const beforeDate = before ? new Date(before) : null;

    const messages = await prisma.chatMessage.findMany({
      where: {
        OR: [
          { fromUserId: me, toUserId: friendId },
          { fromUserId: friendId, toUserId: me },
        ],
        ...(beforeDate ? { createdAt: { lt: beforeDate } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: Math.min(parseInt(take, 10) || 100, 200),
    });

    // Mark friend's messages as read
    await prisma.chatMessage.updateMany({
      where: { fromUserId: friendId, toUserId: me, readAt: null },
      data: { readAt: new Date() },
    });

    res.json(messages.reverse());
  } catch (e) {
    console.error('chat history:', e);
    res.status(500).json({ error: 'Eroare server' });
  }
});

// Send a new message
router.post('/:friendId/messages', async (req, res) => {
  try {
    const me = req.user.id;
    const friendId = req.params.friendId;
    const ok = await ensureFriendship(me, friendId);
    if (!ok) return res.status(403).json({ error: 'Nu sunteți prieteni' });

    const { clientId, text, kind, metadata } = req.body;
    if ((!text || !text.trim()) && (!metadata || Object.keys(metadata || {}).length === 0)) {
      return res.status(400).json({ error: 'Mesaj gol' });
    }

    const normalizedClientId = clientId ? String(clientId) : null;
    if (normalizedClientId) {
      const existing = await prisma.chatMessage.findUnique({
        where: { fromUserId_clientId: { fromUserId: me, clientId: normalizedClientId } },
      });
      if (existing) return res.json(existing);
    }

    const msg = await prisma.chatMessage.create({
      data: {
        clientId: normalizedClientId,
        fromUserId: me,
        toUserId: friendId,
        text: text ? String(text).trim() : null,
        kind: kind || 'text',
        metadata: metadata || null,
      },
    });

    // Push notification (best-effort)
    try {
      const recipient = await prisma.user.findUnique({
        where: { id: friendId },
        select: { pushToken: true },
      });
      if (recipient?.pushToken) {
        const { sendPush } = require('../utils/push');
        const preview = msg.text || (msg.kind === 'doc-share' ? '📄 Document' : msg.kind === 'expense-share' ? '💸 Cheltuială' : 'Mesaj nou');
        sendPush([recipient.pushToken], {
          title: req.user.name,
          body: preview,
          data: { type: 'chat', friendId: me, messageId: msg.id },
        }).catch(() => {});
      }
    } catch {}

    res.status(201).json(msg);
  } catch (e) {
    console.error('chat send:', e);
    res.status(500).json({ error: 'Eroare server' });
  }
});

router.delete('/:friendId/messages/:messageId', async (req, res) => {
  try {
    const me = req.user.id;
    const msg = await prisma.chatMessage.findUnique({ where: { id: req.params.messageId } });
    if (!msg) return res.status(404).json({ error: 'Inexistent' });
    if (msg.fromUserId !== me) return res.status(403).json({ error: 'Poți șterge doar mesajele tale' });
    await prisma.chatMessage.delete({ where: { id: msg.id } });
    res.json({ message: 'Șters' });
  } catch (e) {
    console.error('chat delete:', e);
    res.status(500).json({ error: 'Eroare server' });
  }
});

// Mark a conversation as read explicitly (also done implicitly by GET)
router.post('/:friendId/read', async (req, res) => {
  try {
    const me = req.user.id;
    const friendId = req.params.friendId;
    await prisma.chatMessage.updateMany({
      where: { fromUserId: friendId, toUserId: me, readAt: null },
      data: { readAt: new Date() },
    });
    res.json({ message: 'OK' });
  } catch (e) {
    res.status(500).json({ error: 'Eroare server' });
  }
});

module.exports = router;
