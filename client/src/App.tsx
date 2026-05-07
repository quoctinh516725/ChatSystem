import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Session, User } from '@supabase/supabase-js';
import { supabase, type ConversationRow, type MessageRow, type ProfileRow } from './lib/supabase';
import { useChatSocket } from './hooks/useChatSocket';
import './App.css';

type ConvListItem = ConversationRow & { label: string; memberIds?: string[] };

function AuthScreen({ onSession }: { onSession: (s: Session) => void }) {
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      if (mode === 'signup') {
        const { data, error: err } = await supabase.auth.signUp({
          email,
          password,
          options: { data: { display_name: displayName || email.split('@')[0] } },
        });
        if (err) throw err;
        if (data.session) onSession(data.session);
        else {
          setError('Đăng ký OK — kiểm tra email xác nhận (hoặc tắt Confirm email nếu đang dev).');
        }
      } else {
        const { data, error: err } = await supabase.auth.signInWithPassword({ email, password });
        if (err) throw err;
        if (data.session) onSession(data.session);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Lỗi đăng nhập');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="card auth-form">
      <h1>{mode === 'login' ? 'Đăng nhập' : 'Tạo tài khoản'}</h1>
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        {mode === 'signup' && (
          <input
            placeholder="Tên hiển thị"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
        )}
        <input
          type="email"
          required
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <input
          type="password"
          required
          minLength={6}
          placeholder="Mật khẩu"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error && <p style={{ color: 'var(--danger)', margin: 0, fontSize: '0.9rem' }}>{error}</p>}
        <button type="submit" disabled={loading}>
          {loading ? '…' : mode === 'login' ? 'Vào chat' : 'Đăng ký ngay'}
        </button>
      </form>
      <div className="auth-toggle">
        {mode === 'login' ? (
          <span>
            Chưa có tài khoản?{' '}
            <button type="button" onClick={() => setMode('signup')}>
              Đăng ký
            </button>
          </span>
        ) : (
          <span>
            Đã có tài khoản?{' '}
            <button type="button" onClick={() => setMode('login')}>
              Đăng nhập
            </button>
          </span>
        )}
      </div>
    </div>
  );
}

function ChatApp({ session, user }: { session: Session; user: User }) {
  const token = session.access_token;
  const socketRef = useChatSocket(token);

  const [conversations, setConversations] = useState<ConvListItem[]>([]);
  const [profilesById, setProfilesById] = useState<Record<string, ProfileRow>>({});
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<MessageRow[]>([]);
  const [draft, setDraft] = useState('');
  const [socketReady, setSocketReady] = useState(false);
  const [modal, setModal] = useState<'direct' | 'group' | null>(null);
  const [groupName, setGroupName] = useState('');
  const [selectedUsers, setSelectedUsers] = useState<Record<string, boolean>>({});
  const [typingUsers, setTypingUsers] = useState<Set<string>>(new Set());
  const typingTimeouts = useRef<Record<string, NodeJS.Timeout>>({});
  const myTypingTimeout = useRef<NodeJS.Timeout | null>(null);
  const mergeProfiles = useCallback((rows: ProfileRow[]) => {
    setProfilesById((prev) => {
      const next = { ...prev };
      for (const p of rows) {
        next[p.id] = p;
      }
      return next;
    });
  }, []);

  const refreshConversations = useCallback(() => {
    const socket = socketRef.current;
    if (!socket || !socket.connected) return;    
    socket.emit('get_conversations', {}, (res: any) => {
      if (!res.ok) return console.error('get_conversations err', res.error);

      const { conversations: convs, profiles: profs } = res.data;
      mergeProfiles(profs || []);

      const profileMap: Record<string, ProfileRow> = {};
      for (const p of profs || []) {
        profileMap[p.id] = p;
      }

      const items: ConvListItem[] = (convs || []).map((c: any) => {
        let label = c.name ?? 'Nhóm';
        if (c.type === 'direct') {
          const others = (c.memberIds || []).filter((uid: string) => uid !== user.id);
          const other = others[0];
          label = other ? profileMap[other]?.display_name ?? other.slice(0, 8) : 'Trực tiếp';
        }
        return { ...c, label };
      });

      setConversations(
        items.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()),
      );
    });
  }, [user.id, mergeProfiles, socketRef]);

  useEffect(() => {
    const socket = socketRef.current;
    if (!socket) return;

    const onConnect = () => {
      setSocketReady(true);
      refreshConversations();
    };
    const onDisconnect = () => setSocketReady(false);

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    if (socket.connected) {
      setSocketReady(true);
      refreshConversations();
    }

    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
    };
  }, [socketRef, refreshConversations]);

  const activeConv = useMemo(
    () => conversations.find((c) => c.id === activeId) ?? null,
    [conversations, activeId],
  );

  useEffect(() => {
    const socket = socketRef.current;
    if (!socket || !activeId) {
      setMessages([]);
      setTypingUsers(new Set());
      return;
    }

    const onNew = (msg: MessageRow) => {
      if (msg.conversation_id !== activeId) return;
      setMessages((prev) => {
        if (prev.some((m) => m.id === msg.id)) return prev;
        return [...prev, msg];
      });
    };

    const onTyping = ({ userId, isTyping }: { userId: string; isTyping: boolean }) => {
      if (isTyping) {
        setTypingUsers((prev) => new Set(prev).add(userId));
        if (typingTimeouts.current[userId]) clearTimeout(typingTimeouts.current[userId]);
        typingTimeouts.current[userId] = setTimeout(() => {
          setTypingUsers((prev) => {
            const next = new Set(prev);
            next.delete(userId);
            return next;
          });
        }, 3000);
      } else {
        setTypingUsers((prev) => {
          const next = new Set(prev);
          next.delete(userId);
          return next;
        });
      }
    };

    socket.emit('join_conversation', { conversationId: activeId }, (res: any) => {
      if (!res?.ok) console.warn('join_conversation failed', res);
    });

    socket.on('new_message', onNew);
    socket.on('user_typing', onTyping);

    socket.emit('get_messages', { conversationId: activeId }, (res: any) => {
      if (res.ok) {
        setMessages(res.data || []);
      } else {
        console.error('get_messages err', res.error);
      }
    });

    return () => {
      socket.off('new_message', onNew);
      socket.off('user_typing', onTyping);
      socket.emit('leave_conversation', { conversationId: activeId });
    };
  }, [activeId, socketRef]);

  const send = () => {
    const text = draft.trim();
    const socket = socketRef.current;
    if (!text || !activeId || !socket) return;
    socket.emit('send_message', { conversationId: activeId, body: text }, (res: any) => {
      if (!res?.ok) console.warn('send_message failed', res);
    });
    setDraft('');
    socket.emit('typing', { conversationId: activeId, isTyping: false });
    if (myTypingTimeout.current) clearTimeout(myTypingTimeout.current);
  };

  const loadAllUsers = () => {
    socketRef.current?.emit('get_profiles', {}, (res: any) => {
      if (res.ok) mergeProfiles(res.data || []);
    });
  };

  const openDirectModal = () => {
    setModal('direct');
    loadAllUsers();
  };

  const openGroupModal = () => {
    setModal('group');
    loadAllUsers();
  };

  const startDirect = (otherId: string) => {
    socketRef.current?.emit('create_direct', { otherUserId: otherId }, (res: any) => {
      if (!res.ok) {
        alert(res.error || 'Lỗi tạo chat');
        return;
      }
      setModal(null);
      refreshConversations();
      setActiveId(res.conversationId);
    });
  };

  const createGroup = () => {
    const name = groupName.trim() || 'Nhóm mới';
    const memberIds = Object.entries(selectedUsers)
      .filter(([, v]) => v)
      .map(([k]) => k);

    if (!memberIds.length) {
      alert('Chọn ít nhất một thành viên');
      return;
    }

    socketRef.current?.emit('create_group', { name, memberIds }, (res: any) => {
      if (!res.ok) {
        alert(res.error || 'Lỗi tạo nhóm');
        return;
      }
      setModal(null);
      setGroupName('');
      setSelectedUsers({});
      refreshConversations();
      setActiveId(res.conversationId);
    });
  };

  const allOthers = useMemo(() => {
    return Object.values(profilesById).filter((p) => p.id !== user.id);
  }, [profilesById, user.id]);

  return (
    <div className="card chat-layout">
      <aside className="sidebar">
        <div className="sidebar-header">
          <div className="title-row">
            <strong>Tin nhắn</strong>
          </div>
          <div className="toolbar">
            <button type="button" className="secondary" onClick={openDirectModal}>
              Chat 1-1
            </button>
            <button type="button" className="secondary" onClick={openGroupModal}>
              Nhóm
            </button>
          </div>
          <div className="status-bar">
            <div className={`status-indicator ${!socketReady ? 'offline' : ''}`} />
            {socketReady ? 'Kết nối' : 'Đang chờ...'}
          </div>
        </div>
        <ul className="conv-list">
          {conversations.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                className={c.id === activeId ? 'active' : ''}
                onClick={() => setActiveId(c.id)}
              >
                <div className="conv-name">{c.label}</div>
                <div className="conv-meta">{c.type === 'direct' ? 'Cá nhân' : 'Nhóm chat'}</div>
              </button>
            </li>
          ))}
        </ul>
      </aside>
      <section className="main-pane">
        {!activeConv ? (
          <div className="empty-state">
            <div className="empty-state-icon">💬</div>
            Chọn một cuộc trò chuyện hoặc tạo mới.
          </div>
        ) : (
          <>
            <header className="main-header">{activeConv.label}</header>
            <div className="messages">
              {messages.map((m) => (
                <div key={m.id} className={`msg ${m.sender_id === user.id ? 'own' : ''}`}>
                  <small>
                    {m.sender_id === user.id
                      ? 'Bạn'
                      : profilesById[m.sender_id]?.display_name ?? m.sender_id.slice(0, 8)}
                  </small>
                  {m.body}
                </div>
              ))}
              {Array.from(typingUsers).map((uid) => (
                <div key={`typing-${uid}`} className="typing-indicator">
                  {profilesById[uid]?.display_name ?? uid.slice(0, 8)} đang soạn tin
                  <div className="typing-dots"><span></span><span></span><span></span></div>
                </div>
              ))}
            </div>
            <div className="composer">
              <input
                value={draft}
                placeholder="Gõ tin nhắn..."
                onChange={(e) => {
                  setDraft(e.target.value);
                  if (activeId && socketRef.current) {
                    socketRef.current.emit('typing', { conversationId: activeId, isTyping: true });
                    if (myTypingTimeout.current) clearTimeout(myTypingTimeout.current);
                    myTypingTimeout.current = setTimeout(() => {
                      socketRef.current?.emit('typing', { conversationId: activeId, isTyping: false });
                    }, 2000);
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') send();
                }}
              />
              <button type="button" onClick={send}>
                Gửi
              </button>
            </div>
          </>
        )}
      </section>

      {modal === 'direct' && (
        <div className="modal-backdrop" role="presentation" onClick={() => setModal(null)}>
          <div className="modal" role="dialog" onClick={(e) => e.stopPropagation()}>
            <h2>Chọn bạn bè</h2>
            <div className="modal-body">
              <div className="user-pick-list">
                {allOthers.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className="user-pick-item"
                    onClick={() => startDirect(p.id)}
                    style={{ textAlign: 'left', width: '100%', border: 'none', background: 'rgba(255,255,255,0.05)' }}
                  >
                    <div style={{ flex: 1, color: 'var(--text-primary)' }}>
                      {p.display_name ?? p.id.slice(0, 8)}
                    </div>
                  </button>
                ))}
              </div>
            </div>
            <button type="button" className="secondary" onClick={() => setModal(null)}>
              Đóng
            </button>
          </div>
        </div>
      )}

      {modal === 'group' && (
        <div className="modal-backdrop" role="presentation" onClick={() => setModal(null)}>
          <div className="modal" role="dialog" onClick={(e) => e.stopPropagation()}>
            <h2>Tạo nhóm mới</h2>
            <div className="modal-body">
              <input
                placeholder="Tên nhóm..."
                value={groupName}
                onChange={(e) => setGroupName(e.target.value)}
              />
              <strong style={{ fontSize: '0.9rem', color: 'var(--text-secondary)' }}>
                Thành viên
              </strong>
              <div className="user-pick-list">
                {allOthers.map((p) => (
                  <label key={p.id} className="user-pick-item">
                    <input
                      type="checkbox"
                      checked={Boolean(selectedUsers[p.id])}
                      onChange={(e) =>
                        setSelectedUsers((prev) => ({ ...prev, [p.id]: e.target.checked }))
                      }
                    />
                    <span style={{ color: 'var(--text-primary)' }}>
                      {p.display_name ?? p.id.slice(0, 8)}
                    </span>
                  </label>
                ))}
              </div>
            </div>
            <div style={{ display: 'flex', gap: '0.75rem', marginTop: '0.5rem' }}>
              <button type="button" style={{ flex: 1 }} onClick={createGroup}>
                Tạo nhóm
              </button>
              <button type="button" className="secondary" style={{ flex: 1 }} onClick={() => setModal(null)}>
                Hủy
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<User | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setUser(data.session?.user ?? null);
    });
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, sess) => {
      setSession(sess);
      setUser(sess?.user ?? null);
    });
    return () => subscription.unsubscribe();
  }, []);

  const logout = async () => {
    await supabase.auth.signOut();
  };

  return (
    <div className="app-shell">
      {session && user ? (
        <>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem', padding: '0 1rem' }}>
            <h1 style={{ margin: 0, fontSize: '1.5rem', background: 'var(--accent-gradient)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
              ChatSystem
            </h1>
            <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
              <span style={{ fontSize: '0.9rem', color: 'var(--text-secondary)' }}>
                {user.email}
              </span>
              <button type="button" className="secondary" style={{ padding: '0.5rem 1rem', fontSize: '0.85rem' }} onClick={logout}>
                Đăng xuất
              </button>
            </div>
          </div>
          <ChatApp session={session} user={user} />
        </>
      ) : (
        <AuthScreen
          onSession={(s) => {
            setSession(s);
            setUser(s.user);
          }}
        />
      )}
    </div>
  );
}
