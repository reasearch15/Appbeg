import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";

import LoginProgressOverlay from "@/components/auth/LoginProgressOverlay";
import ClientFirestoreRuntimeAudit from "@/components/client/ClientFirestoreRuntimeAudit";
import {
  PWA_APP_NAME,
  PWA_BACKGROUND_COLOR,
  PWA_THEME_COLOR,
} from "@/lib/pwa/constants";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: PWA_APP_NAME,
  description:
    "Royal VIP Casino — your VIP player lounge for games, bonuses, and rewards.",
  applicationName: PWA_APP_NAME,
  appleWebApp: {
    capable: true,
    title: PWA_APP_NAME,
    statusBarStyle: "black-translucent",
  },
  icons: {
    icon: [
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [
      {
        url: "/icons/apple-touch-icon.png",
        sizes: "180x180",
        type: "image/png",
      },
    ],
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: PWA_THEME_COLOR },
    { media: "(prefers-color-scheme: dark)", color: PWA_BACKGROUND_COLOR },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <ClientFirestoreRuntimeAudit />
        <LoginProgressOverlay />
        {children}
      </body>
    </html>
  );
}
