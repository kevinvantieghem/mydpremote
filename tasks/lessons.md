# Leçons

- Outils MCP (Chrome, etc.) : Kevin ne veut pas de demandes d'autorisation. Ils sont autorisés dans ~/.claude/settings.json (`permissions.allow`). Les utiliser directement, sans demander.
- Git Bash sur ce PC n'a pas les fuseaux horaires (`TZ=Europe/Paris date` renvoie l'heure UTC). Calculer l'heure de Paris avec Node.
- Confirmation par double appui : une actualisation automatique ne doit pas annuler l'état de confirmation.
- Texte avec apostrophes ou backticks (Kotlin, français) : ne pas passer par un heredoc ou printf bash, écrire avec Write ou Edit.
- Faux poêle de test : une commande de puissance ne lance l'allumage que si le poêle est éteint, sinon les tests mentent.
- Remplacements Python dans un heredoc : un `"\n"` destiné au code Kotlin devient un vrai retour à la ligne. Pour du code, utiliser Edit.
- Connexion par code (gh, wrangler) : le code expire vite (15 min). Le relancer juste avant de le donner à Kevin, et vérifier avec `gh auth status` avant de continuer.
- Services en ligne : vérifier que l'inscription est possible pour Kevin AVANT de construire dessus (Cloudflare a bloqué, Deno Deploy ferme).
- Passage GitHub vert : ne prouve pas que le poêle a été joint. Lire le journal de chaque passage, et attendre qu'il soit fini, avant de dire que ça marche.
