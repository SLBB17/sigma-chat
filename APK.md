# Générer l'APK (Capacitor)

Prérequis : Node 18+, Android Studio. Le site doit déjà être en ligne sur Render.

1. Créez un dossier à part : `mkdir sigma-chat-apk && cd sigma-chat-apk && npm init -y`
2. `npm i @capacitor/core @capacitor/cli @capacitor/android`
3. `npx cap init "Sigma Chat" com.sigma.chat --web-dir=www`
4. Copiez le contenu du dossier `public/` du projet dans `sigma-chat-apk/www/`
5. Dans `www/index.html` :
   - remplacez `const API = location.origin;` par `const API = 'https://VOTRE-APP.onrender.com';`
   - remplacez `<script src="/socket.io/socket.io.js"` par `<script src="https://VOTRE-APP.onrender.com/socket.io/socket.io.js"`
6. `npx cap add android && npx cap sync`
7. `npx cap open android` puis dans Android Studio : Build > Build APK(s).
   Le fichier se trouve dans `android/app/build/outputs/apk/debug/`.

Alternative sans Android Studio : importez l'adresse de votre site sur pwabuilder.com pour obtenir l'APK.
