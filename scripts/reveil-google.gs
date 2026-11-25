// Réveil de GitHub toutes les 5 minutes (Google Apps Script).
// Le jeton GitHub est dans Paramètres du projet > Propriétés du script, nom GITHUB_TOKEN.

function reveiller() {
  var jeton = PropertiesService.getScriptProperties().getProperty('GITHUB_TOKEN');
  if (!jeton) throw new Error('Propriété GITHUB_TOKEN absente');
  var rep = UrlFetchApp.fetch(
    'https://api.github.com/repos/kevinvantieghem/mydpremote/actions/workflows/poele.yml/dispatches',
    {
      method: 'post',
      contentType: 'application/json',
      headers: {
        Authorization: 'Bearer ' + jeton,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28'
      },
      payload: JSON.stringify({ ref: 'main' }),
      muteHttpExceptions: true
    }
  );
  if (rep.getResponseCode() !== 204) {
    throw new Error('GitHub ' + rep.getResponseCode() + ' : ' + rep.getContentText());
  }
}

// À lancer une seule fois : crée le déclencheur toutes les 5 minutes.
function installer() {
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('reveiller').timeBased().everyMinutes(5).create();
}
