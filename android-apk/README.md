# ALLCOINS — Android APK

This Android package installs as **ALLCOINS** and opens the existing ALLCOINS Telegram Mini App.

## Why the game opens through Telegram

The existing game backend validates Telegram Mini App `initData` for account, balance, and online game requests. A standalone Android WebView does not receive Telegram-signed `initData`; loading the website directly inside an APK would show the interface but protected account and multiplayer operations would fail authentication.

The APK therefore opens the configured ALLCOINS Mini App link in Telegram. The game, current account, server connection, and online rooms remain the existing Telegram version. No game source, database, or Telegram URL is changed by this Android launcher.

## Build

GitHub Actions builds a debug APK artifact named `allcoins.apk`.

Application ID: `com.allcoins.durakonline`
