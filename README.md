# My DP Remote

App Android pour piloter un poêle à pellets Duepi (boîtier DP Remote) : marche/arrêt, puissance 1 à 5 ou Auto, consigne, données du poêle et plages horaires.

## Comment ça marche
- **Le téléphone** (`android/`, interface dans `public/`) parle directement au relais Duepi.
- **GitHub Actions** (`.github/workflows/poele.yml`) lance `scripts/tick.ts` toutes les 5 minutes environ. Il exécute les plages, le mode Auto et la consigne après un allumage par plage, même téléphone éteint ou sans internet. GitHub peut avoir quelques minutes de retard.
- Les données partagées sont dans `donnees/` :
  - `plages.json` et `prefs.json` sont écrits par l'app ;
  - `etat.json` est écrit par le serveur.
- Mode Auto : le protocole WiFi Duepi n'en a pas. La puissance suit l'écart entre la pièce et la consigne (`autoPower`, dans `src/stove.ts` et `Stove.kt`).

## Secrets
- GitHub (Settings > Secrets > Actions) : `DEVICE_CODE`, `RELAY_HOST`, `RELAY_PORT`.
- App : `android/device.properties` (jamais publié) contient le boîtier, `githubRepo` et `githubToken`. Le jeton est fine-grained, limité à ce dépôt, avec seulement le droit Contents en lecture et écriture.

## Commandes
- `npm test` : tests (protocole, plages, mode Auto, faux relais).
- `DP_CODE=... DP_HOST=... DP_PORT=3000 npm run probe` : lecture seule du vrai poêle.
- `cd android && ./gradlew testDebugUnitTest assembleRelease` : tests et APK.
- `gh workflow run poele.yml -f status=true` : lit l'état du poêle depuis GitHub, sans rien envoyer.

Ferme l'app officielle MyDPremote pendant l'utilisation : deux connexions en même temps se gênent.
