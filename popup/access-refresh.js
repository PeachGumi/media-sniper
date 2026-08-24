'use strict';

// site-access-ui.js injects the temporary activeTab detector asynchronously.
// Reuse the production Rescan button after that injection settles so a user
// opening the popup does not have to close/reopen it just to see first results.
document.addEventListener('media-sniper-access-ready', function (ev) {
  if (!ev.detail || !ev.detail.injected) return;
  setTimeout(function () {
    const btn = document.getElementById('rescan');
    if (btn && !btn.disabled) btn.click();
  }, 350);
});
