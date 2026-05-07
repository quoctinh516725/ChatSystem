import 'dotenv/config';
import http from 'http';
import express from 'express';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import { Server } from 'socket.io';
import { createServiceClient } from './supabase.js';

const PORT = Number(process.env.PORT) || 3001;
const CORS_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:5173';
const JWT_SECRET = process.env.SUPABASE_JWT_SECRET;

if (!JWT_SECRET) {
  console.error('Missing SUPABASE_JWT_SECRET (Dashboard → Settings → API → JWT Secret)');
  process.exit(1);
}

const supabase = createServiceClient();
const app = express();

app.use(cors({ origin: CORS_ORIGIN, credentials: true }));
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: CORS_ORIGIN, methods: ['GET', 'POST'], credentials: true },
});

io.use(async (socket, next) => {
  const token = socket.handshake.auth?.token;
  
  if (!token || typeof token !== 'string') {
    return next(new Error('auth_required'));
  }
  
  try {
    // Sử dụng trực tiếp Supabase để kiểm tra token thay vì tự dùng thư viện jsonwebtoken
    const { data: { user }, error } = await supabase.auth.getUser(token);
    
    if (error || !user) {
      console.error("Lỗi xác thực Supabase:", error.message);
      return next(new Error('invalid_token'));
    }

    console.log("Xác thực thành công. UserID:", user.id);
    socket.data.userId = user.id;
    return next();
  } catch (error) {
    console.error("Lỗi hệ thống khi xác thực:", error.message);
    return next(new Error('server_error'));
  }
});

async function isMember(userId, conversationId) {
  const { data, error } = await supabase
    .from('conversation_members')
    .select('conversation_id')
    .eq('conversation_id', conversationId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) {
    console.error('isMember error', error);
    return false;
  }
  return Boolean(data);
}

io.on('connection', (socket) => {
  const userId = socket.data.userId;
  

  socket.on('join_conversation', async ({ conversationId }, cb) => {
    if (!conversationId) {
      cb?.({ ok: false, error: 'conversationId_required' });
      return;
    }
    const ok = await isMember(userId, conversationId);
    if (!ok) {
      cb?.({ ok: false, error: 'forbidden' });
      return;
    }
    await socket.join(conversationId);
    cb?.({ ok: true });
  });

  socket.on('leave_conversation', ({ conversationId }, cb) => {
    if (conversationId) {
      socket.leave(conversationId);
    }
    cb?.({ ok: true });
  });

  socket.on('send_message', async ({ conversationId, body }, cb) => {
    const text = typeof body === 'string' ? body.trim() : '';
    if (!conversationId || !text) {
      cb?.({ ok: false, error: 'invalid_payload' });
      return;
    }
    const allowed = await isMember(userId, conversationId);
    if (!allowed) {
      cb?.({ ok: false, error: 'forbidden' });
      return;
    }

    const { data: row, error } = await supabase
      .from('messages')
      .insert({
        conversation_id: conversationId,
        sender_id: userId,
        body: text,
      })
      .select('id, conversation_id, sender_id, body, created_at')
      .single();

    if (error) {
      console.error('insert message', error);
      cb?.({ ok: false, error: 'db_error' });
      return;
    }

    io.to(conversationId).emit('new_message', row);
    cb?.({ ok: true, message: row });
  });

  socket.on('get_profiles', async (payload, cb) => {
    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .neq('id', userId);
    if (error) {
      console.error('get_profiles error', error);
      cb?.({ ok: false, error: 'db_error' });
      return;
    }
    cb?.({ ok: true, data });
  });

  socket.on('get_conversations', async (payload, cb) => {
    const { data: memberships, error } = await supabase
      .from('conversation_members')
      .select('conversation_id, conversations ( id, type, name, created_at )')
      .eq('user_id', userId);

    if (error) {
      console.error('get_conversations error', error);
      cb?.({ ok: false, error: 'db_error' });
      return;
    }

    const convIds = [];
    const convMap = new Map();
    for (const row of memberships ?? []) {
      const c = row.conversations;
      if (!c?.id) continue;
      convIds.push(c.id);
      convMap.set(c.id, c);
    }

    if (!convIds.length) {
      cb?.({ ok: true, data: { conversations: [], profiles: [] } });
      return;
    }

    const { data: members } = await supabase
      .from('conversation_members')
      .select('conversation_id, user_id')
      .in('conversation_id', convIds);

    const userIds = new Set();
    const membersByConv = {};
    for (const m of members ?? []) {
      if (!membersByConv[m.conversation_id]) membersByConv[m.conversation_id] = [];
      membersByConv[m.conversation_id].push(m.user_id);
      userIds.add(m.user_id);
    }

    const { data: profs } = await supabase.from('profiles').select('*').in('id', [...userIds]);

    const items = convIds.map((id) => {
      const c = convMap.get(id);
      return {
        ...c,
        memberIds: membersByConv[id] || []
      };
    });

    cb?.({ ok: true, data: { conversations: items, profiles: profs || [] } });
  });

  socket.on('get_messages', async ({ conversationId }, cb) => {
    if (!conversationId) return cb?.({ ok: false });
    const allowed = await isMember(userId, conversationId);
    if (!allowed) return cb?.({ ok: false, error: 'forbidden' });

    const { data, error } = await supabase
      .from('messages')
      .select('*')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: true })
      .limit(200);

    if (error) {
      console.error('get_messages error', error);
      return cb?.({ ok: false, error: 'db_error' });
    }
    cb?.({ ok: true, data });
  });

  socket.on('create_direct', async ({ otherUserId }, cb) => {
    if (!otherUserId) return cb?.({ ok: false });

    // 1. Tìm xem 2 người đã có phòng chat direct nào chung chưa
    const { data: myMemberships } = await supabase
      .from('conversation_members')
      .select('conversation_id')
      .eq('user_id', userId);

    if (myMemberships && myMemberships.length > 0) {
      const myConvIds = myMemberships.map(m => m.conversation_id);
      
      const { data: shared } = await supabase
        .from('conversation_members')
        .select('conversation_id, conversations!inner(type)')
        .eq('user_id', otherUserId)
        .in('conversation_id', myConvIds)
        .eq('conversations.type', 'direct')
        .limit(1);
        
      if (shared && shared.length > 0) {
        // Đã có phòng chat, trả về luôn
        return cb?.({ ok: true, conversationId: shared[0].conversation_id });
      }
    }

    // 2. Nếu chưa có, tạo phòng chat mới
    const { data: conv, error: cErr } = await supabase
      .from('conversations')
      .insert({ type: 'direct', name: null })
      .select('id')
      .single();
      
    if (cErr) {
      console.error('create_direct conv error', cErr);
      return cb?.({ ok: false, error: cErr.message });
    }

    const { error: mErr } = await supabase
      .from('conversation_members')
      .insert([
        { conversation_id: conv.id, user_id: userId },
        { conversation_id: conv.id, user_id: otherUserId }
      ]);
      
    if (mErr) {
      console.error('create_direct members error', mErr);
      return cb?.({ ok: false, error: mErr.message });
    }
    
    cb?.({ ok: true, conversationId: conv.id });
  });

  socket.on('create_group', async ({ name, memberIds }, cb) => {
    if (!memberIds || !memberIds.length) return cb?.({ ok: false });
    const groupName = name || 'Nhóm mới';

    const { data: conv, error: cErr } = await supabase
      .from('conversations')
      .insert({ type: 'group', name: groupName })
      .select('id')
      .single();

    if (cErr || !conv) {
      console.error('create_group conv error', cErr);
      return cb?.({ ok: false, error: cErr?.message || 'create_failed' });
    }

    const rows = [userId, ...memberIds].map(uid => ({
      conversation_id: conv.id,
      user_id: uid
    }));

    const { error: mErr } = await supabase.from('conversation_members').insert(rows);
    if (mErr) {
      console.error('create_group members error', mErr);
      return cb?.({ ok: false, error: mErr.message });
    }

    cb?.({ ok: true, conversationId: conv.id });
  });

  socket.on('typing', async ({ conversationId, isTyping }) => {
    if (!conversationId) return;
    const allowed = await isMember(userId, conversationId);
    if (!allowed) return;

    // Broadcast to everyone else in the room that this user is typing
    socket.to(conversationId).emit('user_typing', {
      userId,
      isTyping
    });
  });
});

server.listen(PORT, () => {
  console.log(`Socket server listening on http://localhost:${PORT}`);
});
