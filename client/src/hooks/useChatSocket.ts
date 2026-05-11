import { useEffect, useRef } from 'react';
import { io, type Socket } from 'socket.io-client';
export function useChatSocket(accessToken: string | null) {
  const socketRef = useRef<Socket | null>(null);
  useEffect(() => {
    if (!accessToken) {
      if (socketRef.current) {
        socketRef.current.disconnect();
        socketRef.current = null;
      }
      return;
    }
    

    const socket = io({
      path: "/api/socket.io",
      auth: { token: accessToken },
      autoConnect: true,
      reconnection: true,
      transports: ['websocket'], 
    });

    socketRef.current = socket;

    return () => {
      socket.disconnect();
      if (socketRef.current === socket) {
        socketRef.current = null;
      }
    };
  }, [accessToken]);

  return socketRef;
}
