# Дурак Онлайн — Android APK

The installable Android app is a small native launcher for the existing ALLCOINS Telegram Mini App.

## Why the game opens through Telegram

The current game backend verifies Telegram Mini App `initData` for room and player requests. A normal Android WebView does not receive Telegram-signed `initData`, so loading the website directly inside an APK would show the interface but multiplayer actions would fail authentication. The APK therefore opens the configured Mini App link in Telegram, where the existing authentication and online game continue to work.

## Build

The GitHub Actions workflow builds an installable debug APK and publishes it as a GitHub Release asset. The APK is named `durak-online.apk`.

Application ID: `com.allcoins.durakonline`
