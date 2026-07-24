'use client';

import { playerDebugLog } from '@/lib/client/playerDebugLogs';
const PLAYER_THEME = 'player';
const WRONG_ROLE_THEME_PATTERN = /(carer|admin|coadmin|staff)/i;
const ROLE_THEME_STORAGE_PATTERN =
  /(?:carer|admin|coadmin|staff).*(?:theme|music|audio)|(?:theme|music|audio).*(?:carer|admin|coadmin|staff)/i;
const PLAYER_SOUND_EFFECT_TRACKS = ['/gift.mp3', '/play.mp3', '/urgency-sound.mp3'] as const;

type PlayerThemeGuardInput = {
  currentPath: string;
  resolvedRole: string | null | undefined;
  audioTheme?: string | null;
};

type AudioCtor = typeof Audio;

declare global {
  interface Window {
    __appbegPlayerThemeAudioGuardInstalled?: boolean;
    __appbegNativeAudioCtor?: AudioCtor;
    __appbegThemeAudioElements?: Set<HTMLAudioElement>;
    __appbegPlayerThemeAudioGuardCurrent?: HTMLAudioElement | null;
  }
}

function isPlayerPath(path: string) {
  return path === '/player' || path.startsWith('/player/');
}

function getAudioTheme(audio: HTMLAudioElement) {
  return (
    audio.dataset.appbegAudioTheme ||
    audio.dataset.audioTheme ||
    audio.getAttribute('data-theme') ||
    ''
  ).toLowerCase();
}

function getAudioPath(audio: HTMLAudioElement, fallbackSrc?: string | null) {
  const source = audio.currentSrc || audio.src || fallbackSrc || '';
  try {
    return new URL(source, window.location.href).pathname;
  } catch {
    return source.split('?')[0].split('#')[0];
  }
}

function audioPathMatches(audio: HTMLAudioElement, tracks: readonly string[], fallbackSrc?: string | null) {
  const path = getAudioPath(audio, fallbackSrc);
  return tracks.some((track) => path === track || path.endsWith(track));
}

function isPlayerThemeAudio(audio: HTMLAudioElement, playerTracks: readonly string[]) {
  const theme = getAudioTheme(audio);
  if (theme === PLAYER_THEME) {
    return true;
  }
  return audioPathMatches(audio, playerTracks);
}

function isAllowedPlayerRouteAudio(
  audio: HTMLAudioElement,
  playerTracks: readonly string[],
  fallbackSrc?: string | null
) {
  return (
    isPlayerThemeAudio(audio, playerTracks) ||
    audioPathMatches(audio, PLAYER_SOUND_EFFECT_TRACKS, fallbackSrc)
  );
}

function shouldStopAudio(audio: HTMLAudioElement, playerTracks: readonly string[]) {
  if (audio.paused && audio.currentTime === 0) {
    return false;
  }
  if (isAllowedPlayerRouteAudio(audio, playerTracks)) {
    return false;
  }
  const theme = getAudioTheme(audio);
  const src = audio.currentSrc || audio.src || '';
  return Boolean(theme || WRONG_ROLE_THEME_PATTERN.test(src) || src.includes('/theme'));
}

function stopAudio(audio: HTMLAudioElement) {
  audio.pause();
  try {
    audio.currentTime = 0;
  } catch {
    // Ignore media seek failures for streams or unloaded elements.
  }
}

export function playerThemeRouteGuard(input: PlayerThemeGuardInput) {
  const routeAllowed = isPlayerPath(input.currentPath);
  const roleAllowed = String(input.resolvedRole || '').toLowerCase() === PLAYER_THEME;
  const themeAllowed = String(input.audioTheme || '').toLowerCase() === PLAYER_THEME;
  const allowed = routeAllowed && roleAllowed && themeAllowed;

  playerDebugLog('[PLAYER_THEME_AUDIO] routeGuard', {
    currentPath: input.currentPath,
    resolvedRole: input.resolvedRole || null,
    audioTheme: input.audioTheme || null,
    allowed,
  });

  if (routeAllowed && (!roleAllowed || !themeAllowed)) {
    if (routeAllowed && input.audioTheme && String(input.audioTheme).toLowerCase() !== PLAYER_THEME) {
      playerDebugLog('[THEME_AUDIO_GUARD] blockedWrongThemeOnPlayer', {
        currentPath: input.currentPath,
        requestedTheme: input.audioTheme,
      });
    }
    playerDebugLog('[PLAYER_THEME_AUDIO] blockedUntilRoleResolved', {
      currentPath: input.currentPath,
      resolvedRole: input.resolvedRole || null,
      audioTheme: input.audioTheme || null,
    });
    playerDebugLog('[PLAYER_THEME_AUDIO] waitingForRole', {
      currentPath: input.currentPath,
      resolvedRole: input.resolvedRole || null,
      audioTheme: input.audioTheme || null,
    });
  }

  if (allowed) {
    playerDebugLog('[PLAYER_THEME_AUDIO] playerThemeAllowed', {
      currentPath: input.currentPath,
      resolvedRole: input.resolvedRole || null,
      audioTheme: input.audioTheme || null,
    });
  }

  return allowed;
}

export function tagPlayerThemeAudio(audio: HTMLAudioElement) {
  audio.dataset.appbegAudioTheme = PLAYER_THEME;
}

export function stopDuplicatePlayerThemeAudio(
  currentAudio: HTMLAudioElement,
  playerTracks: readonly string[]
) {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return;
  }

  const tracked = Array.from(window.__appbegThemeAudioElements || []);
  const documentAudio = Array.from(document.querySelectorAll('audio'));
  const allAudio = Array.from(new Set([...tracked, ...documentAudio]));
  let stopped = 0;

  for (const audio of allAudio) {
    if (audio === currentAudio || !isPlayerThemeAudio(audio, playerTracks)) {
      continue;
    }
    if (audio.paused && audio.currentTime === 0) {
      continue;
    }
    stopAudio(audio);
    stopped += 1;
  }

  if (stopped > 0) {
    playerDebugLog('[PLAYER_THEME_AUDIO] duplicateLoopPrevented', { stopped });
  }
  window.__appbegPlayerThemeAudioGuardCurrent = currentAudio;
}

export function stopWrongPlayerRouteThemeAudio(playerTracks: readonly string[]) {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return;
  }

  const tracked = Array.from(window.__appbegThemeAudioElements || []);
  const documentAudio = Array.from(document.querySelectorAll('audio'));
  const allAudio = Array.from(new Set([...tracked, ...documentAudio]));
  let stopped = 0;

  for (const audio of allAudio) {
    if (!shouldStopAudio(audio, playerTracks)) {
      continue;
    }
    stopAudio(audio);
    stopped += 1;
  }

  if (stopped > 0) {
    playerDebugLog('[PLAYER_THEME_AUDIO] stoppedWrongTheme', { stopped });
    playerDebugLog('[THEME_AUDIO_GUARD] stoppedLeakedTheme', { stopped });
  }
}

export function clearStaleRoleThemeStorage() {
  if (typeof window === 'undefined') {
    return;
  }

  for (const storage of [window.localStorage, window.sessionStorage]) {
    try {
      for (let index = storage.length - 1; index >= 0; index -= 1) {
        const key = storage.key(index) || '';
        if (ROLE_THEME_STORAGE_PATTERN.test(key)) {
          storage.removeItem(key);
        }
      }
    } catch {
      // Ignore storage access failures.
    }
  }
}

export function installPlayerThemeAudioGuard(playerTracks: readonly string[]) {
  if (typeof window === 'undefined' || window.__appbegPlayerThemeAudioGuardInstalled) {
    return;
  }

  const NativeAudio = window.Audio;
  window.__appbegNativeAudioCtor = NativeAudio;
  window.__appbegThemeAudioElements = window.__appbegThemeAudioElements || new Set();

  const GuardedAudio = function AudioGuard(src?: string) {
    const audio = new NativeAudio(src);
    window.__appbegThemeAudioElements?.add(audio);
    const nativePlay = audio.play.bind(audio);
    audio.play = (() => {
      const path = window.location.pathname;
      if (isPlayerPath(path) && !isAllowedPlayerRouteAudio(audio, playerTracks, src)) {
        stopAudio(audio);
        playerDebugLog('[THEME_AUDIO_GUARD] blockedWrongThemeOnPlayer', {
          currentPath: path,
          source: audio.currentSrc || audio.src || src || null,
          audioTheme: getAudioTheme(audio) || null,
        });
        playerDebugLog('[THEME_AUDIO_GUARD] stoppedLeakedTheme', {
          stopped: 1,
          source: audio.currentSrc || audio.src || src || null,
        });
        return Promise.resolve();
      }
      if (isPlayerPath(path) && isPlayerThemeAudio(audio, playerTracks)) {
        stopDuplicatePlayerThemeAudio(audio, playerTracks);
      }
      return nativePlay();
    }) as typeof audio.play;

    const path = window.location.pathname;
    if (isPlayerPath(path) && !isAllowedPlayerRouteAudio(audio, playerTracks, src)) {
      window.setTimeout(() => {
        if (shouldStopAudio(audio, playerTracks)) {
          stopAudio(audio);
          playerDebugLog('[PLAYER_THEME_AUDIO] stoppedWrongTheme', {
            stopped: 1,
            source: src || audio.currentSrc || audio.src || null,
          });
          playerDebugLog('[THEME_AUDIO_GUARD] stoppedLeakedTheme', {
            stopped: 1,
            source: src || audio.currentSrc || audio.src || null,
          });
        }
      }, 0);
    }

    return audio;
  } as unknown as AudioCtor;

  GuardedAudio.prototype = NativeAudio.prototype;
  window.Audio = GuardedAudio;
  window.__appbegPlayerThemeAudioGuardInstalled = true;
}
