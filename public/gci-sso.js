/*
 * SSO do hub GCI (gci.arvore.party / app.arvore.party).
 * Quando o Farol é aberto embedado no hub e cai na tela de login, recebe a credencial
 * do Chatwoot (já validada no login único do hub), troca por uma sessão via /api/auth/sso
 * e entra — sem pedir senha. Fora do hub, não faz nada.
 */
(function () {
  try {
    if (window.top === window.self) return;            // só dentro do hub (iframe)
    // Varredura de logout do hub: encerra a sessão do Farol (limpa farol_token, inclusive o
    // particionado do embed). sendBeacon sobrevive ao redirect da /login (não é cancelado pela
    // navegação), garantindo que o /api/auth/logout complete.
    if (location.search.indexOf('gci_logout') >= 0) {
      try {
        if (navigator.sendBeacon) navigator.sendBeacon('/api/auth/logout');
        else fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
      } catch (_) {}
      return;
    }
    var HUB_ORIGINS = ['https://gci.arvore.party', 'https://app.arvore.party'];
    var done = false;

    var hide = document.createElement('style');
    hide.id = 'gci-sso-hide';
    hide.textContent = 'body{visibility:hidden}';
    document.documentElement.appendChild(hide);
    function reveal() { var s = document.getElementById('gci-sso-hide'); if (s) s.remove(); }

    window.addEventListener('message', function (e) {
      if (done || HUB_ORIGINS.indexOf(e.origin) === -1) return;
      var m = e.data || {};
      if (m.type === 'gci-sso' && m.access_token) {
        done = true;
        fetch('/api/auth/sso', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cred: {
            access_token: m.access_token, token_type: m.token_type,
            client: m.client, uid: m.uid
          } })
        }).then(function (r) {
          if (r.ok) window.location.replace('/');
          else reveal();
        }).catch(function () { reveal(); });
      }
    });

    try { window.top.postMessage({ type: 'gci-ready' }, '*'); } catch (_) {}
    setTimeout(function () { if (!done) reveal(); }, 2000);
  } catch (_) {}
})();
