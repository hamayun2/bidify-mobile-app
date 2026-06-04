import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';
import ChatbotBottomPanel from '../components/ChatbotBottomPanel';

const ChatbotPanelContext = createContext(null);

export function ChatbotPanelProvider({ children }) {
  const [visible, setVisible] = useState(false);

  const open = useCallback(() => setVisible(true), []);
  const close = useCallback(() => setVisible(false), []);
  const toggle = useCallback(() => setVisible((v) => !v), []);

  const value = useMemo(
    () => ({ visible, open, close, toggle }),
    [visible, open, close, toggle]
  );

  return (
    <ChatbotPanelContext.Provider value={value}>
      {children}
      <ChatbotBottomPanel visible={visible} onClose={close} />
    </ChatbotPanelContext.Provider>
  );
}

export function useChatbotPanel() {
  const ctx = useContext(ChatbotPanelContext);
  if (!ctx) {
    throw new Error('useChatbotPanel must be used within ChatbotPanelProvider');
  }
  return ctx;
}
