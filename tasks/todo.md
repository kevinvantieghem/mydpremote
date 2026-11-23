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
- [ ] Premier passage programmé (cron) observé sur GitHub
- [ ] Extinction par GitHub à la fin de la plage « Soir » (22:50, lundi 23/11)
- [ ] Allumage par GitHub, WiFi du téléphone coupé (plage « Matin » 07:50 le 24/11 ; attention, la télécommande a aussi un minuteur 7:50 ON)
- [ ] Test du bouton Auto sur le vrai poêle
- [ ] Comparer les heures (12695 / 2942) et RD4000 avec l'app officielle
- [ ] Pressostat affiché « Défaut » alors que le poêle chauffe normalement (RC0000 = 0x0000 en chauffe) : signification du registre à revoir

## Revue
- Vérifié : tests, build signé, lecture réelle depuis GitHub Actions, écriture des plages avec le jeton de l'app, interface sur le téléphone.
- Pas encore vérifié : le déclenchement programmé (cron) et une commande réelle envoyée par GitHub.
- Limites : GitHub peut lancer le passage en retard (rattrapage de 45 min). Les plages sont publiques. Le jeton de l'app peut expirer : si c'est le cas, l'écran Horaires affiche « jeton GitHub refusé ou expiré ».
