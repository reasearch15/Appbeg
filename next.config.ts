import type { NextConfig } from "next";

function cleanFlag(value: string | undefined) {
  return String(value || '').trim();
}

function isEnabled(value: string | undefined) {
  const raw = cleanFlag(value).toLowerCase();
  return raw === '1' || raw === 'true';
}

const sqlOnlyMode = isEnabled(process.env.APPBEG_SQL_ONLY_MODE);
const publicSqlReadMode =
  cleanFlag(process.env.NEXT_PUBLIC_SQL_READ_MODE) ||
  (sqlOnlyMode ? '1' : '');
const publicSqlLoginFirst =
  cleanFlag(process.env.NEXT_PUBLIC_SQL_LOGIN_FIRST) ||
  (sqlOnlyMode ? '1' : '');
const publicSqlPlayerLogin =
  cleanFlag(process.env.NEXT_PUBLIC_SQL_PLAYER_LOGIN) ||
  (sqlOnlyMode ? '1' : '');

const firebaseRuntimeAliases = {
  'firebase/app': './lib/firebase/runtimeDisabledApp.ts',
  'firebase/auth': './lib/firebase/runtimeDisabledAuth.ts',
  'firebase/firestore': './lib/firebase/runtimeDisabledFirestore.ts',
  'firebase/storage': './lib/firebase/runtimeDisabledStorage.ts',
};

const nextConfig: NextConfig = {
  env: {
    NEXT_PUBLIC_SQL_LOGIN_FIRST: publicSqlLoginFirst,
    NEXT_PUBLIC_SQL_PLAYER_LOGIN: publicSqlPlayerLogin,
    NEXT_PUBLIC_SQL_READ_MODE: publicSqlReadMode,
  },
  turbopack: {
    resolveAlias: firebaseRuntimeAliases,
  },
  webpack(config) {
    config.resolve = config.resolve || {};
    config.resolve.alias = {
      ...(config.resolve.alias || {}),
      ...firebaseRuntimeAliases,
    };
    return config;
  },
  async headers() {
    const playerStaticImageCache = [
      {
        key: 'Cache-Control',
        value: 'public, max-age=604800, stale-while-revalidate=2592000',
      },
    ];

    return [
      {
        source: '/assets/player/:path*',
        headers: playerStaticImageCache,
      },
      {
        source: '/gamebackgroundimage/:path*',
        headers: playerStaticImageCache,
      },
    ];
  },
};

export default nextConfig;
