import type { PlayerView } from './types';

export const DEFAULT_GAME_BACKGROUND_IMAGE = '/gamebackgroundimage/game-vault.png';

export const GAME_BACKGROUND_IMAGE_BY_KEY: Record<string, string> = {
  cashfrenzy: '/gamebackgroundimage/cash-frenzy.png',
  firekirin: '/gamebackgroundimage/fire-kirin.png',
  gamevault: '/gamebackgroundimage/game-vault.png',
  juwa: '/gamebackgroundimage/juwa.png',
  juwa2: '/gamebackgroundimage/juwa-2.png',
  mafia: '/gamebackgroundimage/mafia.png',
  milkyway: '/gamebackgroundimage/milky-way.png',
  orionstars: '/gamebackgroundimage/orion-stars.png',
  ultrapanda: '/gamebackgroundimage/ultra-panda.png',
  vblink: '/gamebackgroundimage/vb-link.png',
  vegassweeps: '/gamebackgroundimage/vegas-sweeps.png',
};

export const MAX_REQUEST_HISTORY_DISPLAY = 30;

export const PLAYER_SPLASH_BACKDROP =
  'fixed inset-0 flex items-end justify-center bg-black/80 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-10 backdrop-blur-xl sm:items-center sm:px-4 sm:pb-0';

export const PLAYER_SPLASH_BACKDROP_CENTER =
  'fixed inset-0 flex items-center justify-center bg-black/82 p-4 backdrop-blur-xl';

export const PLAYER_SPLASH_CARD =
  'w-full max-w-md rounded-3xl border border-amber-400/25 bg-gradient-to-b from-[#121018] via-zinc-950/98 to-black p-6 shadow-2xl shadow-amber-500/10 sm:rounded-3xl sm:p-7';

export const PLAYER_SPLASH_CARD_WIDE =
  'w-full max-w-lg rounded-3xl border border-amber-400/25 bg-gradient-to-b from-[#121018] via-zinc-950/98 to-black p-6 shadow-2xl shadow-amber-500/10 sm:max-w-2xl sm:p-7';

export const CASINO_BACKGROUND_TRACKS = ['/theme3.mp3'] as const;
export const PLAYER_MUSIC_STORAGE_KEY = 'playerBackgroundMusicEnabled';
export const DEFAULT_PLAYER_MUSIC_VOLUME = 0.3;

export const PLAYER_HELP_HINT_MESSAGE =
  'Press Play to get your game recharged, and click Menu to see more offers.';

export const ACTIVE_TABLE_SPLASH_HISTORY_KEY = '__playerActiveTableSplash';
export const RECENT_PLAY_AMOUNT_LIMIT = 5;
export const GLOBAL_RECENT_PLAY_AMOUNT_STORAGE_KEY = 'appbeg:recentAmounts:global';
export const UNKNOWN_CREATOR_FILTER_KEY = '__unknown_creator__';

export const NAV_ITEMS: {
  label: string;
  view: PlayerView;
  icon: string;
  emoji: string;
}[] = [
  { label: 'Lobby', view: 'dashboard', icon: 'tachometer-alt', emoji: '🏠' },
  { label: 'Play', view: 'play', icon: 'dice-d6', emoji: '🎰' },
  { label: 'Bonus', view: 'bonus-events', icon: 'gift', emoji: '🎁' },
  { label: 'Earn Coins', view: 'earn-coins', icon: 'coins', emoji: '🪙' },
  { label: 'Agents', view: 'agents', icon: 'headset', emoji: '💬' },
  { label: 'Vault', view: 'usernames', icon: 'user-secret', emoji: '🔐' },
];

export const SWIPE_NAV_VIEWS: PlayerView[] = [
  'dashboard',
  'bonus-events',
  'earn-coins',
  'agents',
  'usernames',
];
