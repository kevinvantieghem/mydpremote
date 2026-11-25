# My DP Remote : suivi

Plan : C:\Users\pc\.claude\plans\est-ce-que-tu-peux-serene-codd-of-da2645f2-2b15-4897-ae4e-4ce57307b813.md

Dépôt public : https://github.com/kevinvantieghem/mydpremote

## Historique
- 23/11 : app Android sur le téléphone (v1.0, v1.1). Marche/arrêt et une plage app fermée vérifiés sur le vrai poêle.
- 23/11 : Kevin coupe le WiFi la nuit, donc les plages doivent partir sans le téléphone. L'inscription Cloudflare a échoué (erreur OAuth, même par e-mail). Rien ne reste allumé chez lui. Choix : GitHub Actions.
- 23/11 : mode Auto demandé (le « A » de la télécommande). Il n'existe pas dans le protocole WiFi (InterstoveRemoteCmd.pdf, Duepi_EVO), donc on le gère nous-mêmes.

## v1.3 : GitHub Actions et mode Auto
- [x] `src/runner.ts` : plages (rattrapage de 45 min), consigne en attente, mode Auto. `scripts/tick.ts`, `.github/workflows/poele.yml`, toutes les 5 min.
- [x] `autoPower` : écart de 2 °C ou plus = 5, 1,5 °C = 4, 1 °C = 3, 0,5 °C = 2, sinon 1. Envoyée seulement en chauffe stable, et si elle diffère de RD3000.
- [x] Cloudflare retiré (index.ts, cfTransport.ts, wrangler.toml).
- [x] App : `GitHubCloud` (API Contents), bouton Auto, `Config.auto`, versionCode 4.
- [x] Tests : 34 Vitest, 18 JUnit (1 ignoré : le vrai poêle).
- [x] Dépôt créé, secrets DEVICE_CODE, RELAY_HOST et RELAY_PORT posés, jeton fine-grained de l'app dans device.properties.
- [x] Lecture seule depuis GitHub : « En chauffe, pièce 20.3 °C, puissance 5 ». GitHub joint bien le relais.
- [x] v1.3 installée sur le S24. Bouton Auto visible. Les 3 plages du téléphone sont migrées dans `donnees/plages.json`.
- [x] Cron GitHub peu fiable : un seul passage programmé en 13 h (24/11 à 05:59, Paris). Solution : `scripts/reveil-google.gs` (Apps Script, jeton Actions seul, dans les propriétés du script) lance le workflow toutes les 5 min. Vérifié le 24/11 : passages à 11:31 et 11:36.
- [x] Extinction de plage qui échoue : réessayée à chaque passage jusqu'à réussir (`pendingOff`), abandonnée si une plage reprend. Plage en échec = passage rouge, poêle injoignable sans plage = avertissement. 38 tests, en ligne le 24/11 à 20:33 ; le réessai n'a pas encore été vu sur le vrai poêle.
- [x] Coupures du 24/11 après-midi (12:56 à 17:46) : Kevin confirme des coupures du réseau, WiFi et internet coupés.
- [ ] Échecs du 24/11 hors après-midi (05:59, 11:29, 11:56 à 12:26) : cause non confirmée
- [x] Soirée du 24/11, minuteur de la télécommande annoncé coupé par Kevin : allumage 21:01 (chauffe 21:16), extinction 22:51 (plus en chauffe à 23:06)
- [x] Matin du 25/11 : allumage 07:51 (chauffe 08:11), extinction 09:51 (plus en chauffe à 10:01)
- [x] Extinction par GitHub à la fin de la plage « Soir » (lancement manuel à 22:51 le 23/11, poêle en Extinction, puissance réelle 0)
- [x] Allumage par GitHub, WiFi et données du téléphone coupés (confirmé par Kevin) : plage « Matin » du 25/11, 07:51
- [x] Auto sur le vrai poêle : puissance 1 le 23/11 (20,6 °C), 5 puis 4 les 24 et 25/11
- [ ] Comparer les heures (12695 / 2942) et RD4000 avec l'app officielle
- [x] Pressostat : le poêle renvoie 0x0000 à l'arrêt comme en chauffe, ni OK (0x0100) ni défaut (0x0300) d'après aceindy/Duepi_EVO. Carte masquée pour toute autre valeur. Un vrai défaut passe par l'erreur 6 (RDA000). v1.4 : 39 Vitest, 19 JUnit (+1 ignoré), APK signé.
- [x] v1.4 installée sur le S24 le 25/11, poêle éteint : carte Pressostat absente, les autres cartes affichées (12702 / 2949 h)
- [ ] Revoir l'écran en chauffe (carte Pressostat toujours absente)

## Revue
- Vérifié : tests, build signé, lecture réelle depuis GitHub Actions, écriture des plages avec le jeton de l'app, interface sur le téléphone.
- Vérifié les 24 et 25/11 : allumages et extinctions réels par GitHub, réveillé par Google toutes les 5 min.
- Pas encore vérifié : le réessai d'extinction sur le vrai poêle.
- À surveiller : expiration du jeton `reveil-google` ; s'il expire, plus aucun réveil fiable.
- Limites : GitHub peut lancer le passage en retard (rattrapage de 45 min). Les plages sont publiques. Le jeton de l'app peut expirer : si c'est le cas, l'écran Horaires affiche « jeton GitHub refusé ou expiré ».
