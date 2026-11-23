# My DP Remote : suivi

Plan : C:\Users\pc\.claude\plans\est-ce-que-tu-peux-serene-codd-of-da2645f2-2b15-4897-ae4e-4ce57307b813.md

Le 23/11, Kevin a choisi l'app sur son téléphone, sans hébergement en ligne. La version Cloudflare (`src/`, `wrangler.toml`) n'est plus déployée. Elle reste comme référence du protocole.

## Construction (app Android, dossier android/)
- [x] Projet Gradle (config reprise de Ccleaner GSM). Interface = dossier public/ servi dans une WebView.
- [x] Protocole (Duepi.kt), logique poêle (Stove.kt), plages (Scheduler.kt), stockage (Store.kt), logique de l'app (Api.kt)
- [x] Horaires app fermée : alarme exacte sur la prochaine borne, WorkManager, consigne en attente, redémarrage du téléphone (Background.kt)
- [x] Interface : PIN retiré, réglages serveur/port/code modifiables, bouton batterie, pressostat « Au repos » quand le poêle est éteint
- [x] 22 tests JUnit (trame de référence, plages, logique complète contre un faux poêle)
- [x] APK release signé : `MyDPRemote.apk` (clé dans android/keystore, mots de passe dans android/keystore.properties)

## Avec Kevin
- [x] Code du QR code et serveur relais (1.duepiwebserver1.com:3000)
- [x] Lecture seule du vrai poêle : sonde TS et code Kotlin donnent les mêmes valeurs
- [x] Installer l'APK sur le téléphone (23/11, Galaxy S24, copie par USB en mode fichiers : l'app affiche Éteint et 17°, donc le pont WebView et la connexion au relais marchent sur le téléphone)
- [x] Mettre la batterie de l'app sur « Non restreinte » (vérifié par adb : liste blanche deviceidle)
- [x] Test marche / arrêt (23/11 : allumage puis extinction OK sur le vrai poêle)
- [x] v1.1 : la barre d'onglets ne passe plus sous les boutons Android (marge sur un FrameLayout, la WebView ignore son padding). Vérifié par capture d'écran du téléphone.
- [x] Test d'une plage, app fermée et téléphone verrouillé (23/11 : 15:40:03 allumage, 15:42:03 extinction, vus dans logcat)
- [ ] Comparer les heures (12694 / 2941) et RD4000 avec l'app officielle

## Revue
- Vérifié : tests JUnit, `assembleRelease`, signature de l'APK, lecture réelle du poêle en Kotlin, interface dans Chrome avec un faux pont.
- Pas encore vérifié sur le téléphone : le pont WebView, les alarmes app fermée, l'écriture sur le vrai poêle.
- Limite : les plages ne marchent que si le téléphone est allumé et a internet à l'heure prévue. Le rattrapage dure 10 minutes.
