'use client';

import { memo, useRef } from 'react';
import ReachOutView from '@/components/admin/ReachOutView';
import { playerDevLog } from '@/lib/client/playerDebugLogs';
import { usePlayerRenderPerf } from '../performance';

type Props = Record<string, any>;
const PLAYER_RENDER_DEBUG = process.env.NEXT_PUBLIC_PLAYER_RENDER_DEBUG === '1';

function Agents(props: Props) {
  const {
    agentOnlineByUid,
    agents,
    agentsScrollRef,
    handleAgentSelect,
    handleClearImage,
    handleImageSelect,
    handleSendMessage,
    onBackToAgents,
    imagePreview,
    messages,
    newMessage,
    onMessageFocus,
    pagedAgentChat,
    selectedAgent,
    sendingImage,
    setNewMessage,
    unreadCounts,
  } = props;
  const renderDebugCountRef = useRef(0);
  const isChatOpen = Boolean(selectedAgent);

  usePlayerRenderPerf('Agents', () => ({
    isChatOpen,
    agentCount: agents.length,
    messageCount: messages.length,
    unreadThreadCount: Object.keys(unreadCounts || {}).length,
  }));

  if (PLAYER_RENDER_DEBUG) {
    renderDebugCountRef.current += 1;
    playerDevLog('[PLAYER_RENDER_DEBUG]', {
      component: 'Agents',
      count: renderDebugCountRef.current,
      isChatOpen,
      agentCount: agents.length,
      unreadThreadCount: Object.keys(unreadCounts || {}).length,
      atMs: Date.now(),
    });
  }

  return (

              <div
                className={`player-agents-shell flex min-h-0 min-w-0 flex-col overflow-hidden lg:h-[calc(100dvh_-_7rem)] lg:max-h-[calc(100dvh_-_7rem)] lg:flex-1 ${
                  isChatOpen
                    ? 'player-agents-shell--chat flex-1 h-[calc(100dvh_-_12.5rem_-_env(safe-area-inset-bottom))] max-h-[calc(100dvh_-_12.5rem_-_env(safe-area-inset-bottom))]'
                    : 'flex-1 max-h-[min(78dvh,calc(100dvh-11rem))] sm:max-h-[min(82dvh,calc(100dvh-10rem))]'
                }`}
              >
                <ReachOutView
                  chatUsers={agents}
                  selectedChatUser={selectedAgent}
                  messages={messages}
                  newMessage={newMessage}
                  unreadCounts={unreadCounts}
                  imagePreview={imagePreview}
                  sendingImage={sendingImage}
                  messagesScrollRef={agentsScrollRef}
                  hasMoreOlderMessages={false}
                  loadingOlderMessages={pagedAgentChat.loadingOlder}
                  onLoadOlderMessages={undefined}
                  disableLoadOlder
                  playerLightweightMode
                  onSelectUser={handleAgentSelect}
                  onMessageChange={setNewMessage}
                  onMessageFocus={onMessageFocus}
                  onSendMessage={handleSendMessage}
                  onImageSelect={handleImageSelect}
                  onClearImage={handleClearImage}
                  onBackToList={onBackToAgents}
                  onlineByUid={agentOnlineByUid}
                />
              </div>
  );
}

export default memo(Agents);
